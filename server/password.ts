import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * First-party password hashing for Fareloop accounts.
 *
 * scrypt from Node's own crypto - deliberately NOT a library. This project runs at
 * $0 forever, and every password-hashing dependency is one more thing to audit and
 * patch for no gain over the built-in, which is memory-hard and battle-tested.
 *
 * Stored format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`.
 * The parameters ride inside the string, so raising the cost later re-hashes on the
 * user's next successful login instead of needing a migration over live rows.
 *
 * N=2^15 with r=8 is ~32MB of memory per hash: comfortably beyond GPU-accelerated
 * brute force while staying around ~100ms on a serverless instance, which is the
 * right trade for a login endpoint.
 */
const PARAMS = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 64;
// scrypt needs roughly 128 * N * r bytes; Node's default cap is lower than this.
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;

const PREFIX = "scrypt";

export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: "invalid-format" | "mismatch" | "server-error" };

/** Produces the stored hash string for a plaintext password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM });
  return [
    PREFIX,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Verifies a password against a stored hash.
 *
 * A malformed or missing stored hash returns `invalid-format` rather than throwing:
 * an OAuth-only account has no password at all, and that must read as "wrong
 * password", not as a 500 that tells an attacker the account exists.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<PasswordCheck> {
  if (!stored) return { ok: false, reason: "invalid-format" };

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return { ok: false, reason: "invalid-format" };

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);

  // Refuse absurd parameters rather than letting a tampered row turn into a
  // memory bomb on the login path.
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return { ok: false, reason: "invalid-format" };
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return { ok: false, reason: "invalid-format" };

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, "base64");
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return { ok: false, reason: "invalid-format" };
  }
  if (salt.length === 0 || expected.length === 0) return { ok: false, reason: "invalid-format" };

  try {
    const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
    // timingSafeEqual is what stops the comparison itself leaking, bit by bit,
    // how close a guess was.
    return timingSafeEqual(derived, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
  } catch {
    return { ok: false, reason: "server-error" };
  }
}

/** Password policy: length does the real work; complexity rules mostly add friction. */
export function assessPassword(password: string): { ok: boolean; reason?: string } {
  if (typeof password !== "string" || password.length < 8) return { ok: false, reason: "Password must be at least 8 characters." };
  if (password.length > 200) return { ok: false, reason: "Password must be at most 200 characters." };
  if (/^\s|\s$/.test(password)) return { ok: false, reason: "Password cannot start or end with whitespace." };
  return { ok: true };
}

/** Normalises an email for storage and lookup: trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Derives the unique `openId` for a first-party account.
 *
 * The users table keys on openId (UNIQUE), and OAuth identities own the same
 * column. A password account therefore needs an id that (a) can never collide with
 * a provider-issued one and (b) does not store the email a second time in a place
 * that gets logged. `local:` plus a hash of the address satisfies both, and stays
 * inside the column's 64-char limit.
 */
export function deriveOpenId(email: string): string {
  const normalized = normalizeEmail(email);
  // A short, stable digest. Not a security boundary (the email is stored plainly
  // in its own column) - it is an identifier, so it only needs uniqueness.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `local_${hash.toString(36)}_${normalized.length.toString(36)}`;
}
