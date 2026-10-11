import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * GO 167 - the two credential gates that a live probe could not isolate.
 *
 * Why this file exists: `auth.register` and `auth.login` were proven working
 * against production (registration creates an account, the cookie authenticates,
 * the paywall and ownership gates both refuse correctly), but two rules behind
 * them are unreachable from a live script:
 *
 *   1. duplicate email  -> CONFLICT
 *   2. no such account  -> UNAUTHORIZED, IDENTICAL to "wrong password"
 *
 * Both sit BEHIND a per-IP rate limiter (`auth:register:` / `auth:login:`, 5 per
 * 60s, in-memory per instance). A verification script legitimately spends calls
 * from one address, so the limiter answers first and the rule under test is never
 * reached - which is exactly what the limiter is supposed to do. Calling the
 * router directly with the limiter pinned open isolates the rule itself.
 *
 * The database is mocked rather than real: the point is the DECISION, and a real
 * schema would make these tests depend on migration state.
 */

// ---- the limiter is pinned open so it cannot answer in place of the gate ----
vi.mock("./_core/rate-limit", () => ({
  hitRateLimit: vi.fn(() => true),
  clientIp: vi.fn(() => "203.0.113.9"),
  RATE_LIMIT_MAX: 20,
  RATE_LIMIT_WINDOW_MS: 60_000,
  DAILY_LIMIT_WINDOW_MS: 86_400_000,
  DAILY_SEARCH_LIMIT: 10,
}));

// ---- password primitives: fast, deterministic, and NOT what we are testing ----
vi.mock("./password", () => ({
  normalizeEmail: vi.fn((e: string) => e.trim().toLowerCase()),
  assessPassword: vi.fn(() => ({ ok: true })),
  hashPassword: vi.fn(async () => "scrypt$fake$hash"),
  deriveOpenId: vi.fn((email: string) => `local_${email}`),
  verifyPassword: vi.fn(),
}));

// ---- session signing: never needs a real JWT_SECRET in the test environment ----
vi.mock("./_core/sdk", () => ({
  sdk: { createSessionToken: vi.fn(async () => "signed.session.token") },
}));

vi.mock("./_core/cookies", () => ({
  getSessionCookieOptions: vi.fn(() => ({ httpOnly: true, path: "/" })),
}));

const db = vi.hoisted(() => ({
  getUserByEmail: vi.fn(),
  createPasswordUser: vi.fn(),
  getUserByOpenId: vi.fn(),
  upsertUser: vi.fn(async () => undefined),
}));
vi.mock("./db", () => db);

const rateLimit = await import("./_core/rate-limit");

// ENV snapshots process.env AT IMPORT TIME, and both handlers call
// assertSessionSecret() before any of the logic these tests exist to exercise.
// Setting a dummy secret ahead of the dynamic import lets the handlers run; the
// value is never used to sign anything because sdk.createSessionToken is mocked.
// run_gate.py strips real tokens, so this is the only secret in the run and it
// is inert.
process.env.JWT_SECRET = "gate-test-only-not-a-real-secret";

const { appRouter } = await import("./routers");
const password = await import("./password");

/** Minimal ctx: req.headers is read by the limiter key, res.cookie by the success path. */
function makeCtx() {
  return {
    req: { headers: { "x-forwarded-for": "203.0.113.9" } },
    res: { cookie: vi.fn() },
    user: null,
  } as unknown as TrpcContext;
}

async function attemptRegister(input: Record<string, unknown>) {
  try {
    await appRouter.createCaller(makeCtx()).auth.register(input as never);
    return "ALLOWED";
  } catch (error) {
    return (error as { code?: string }).code ?? "THREW";
  }
}

async function attemptLogin(input: Record<string, unknown>) {
  try {
    await appRouter.createCaller(makeCtx()).auth.login(input as never);
    return "ALLOWED";
  } catch (error) {
    return (error as { code?: string }).code ?? "THREW";
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-open the limiter after clearAllMocks resets the default implementation.
  vi.mocked(rateLimit.hitRateLimit).mockReturnValue(true);
});

describe("auth.register duplicate email (GO 167)", () => {
  it("returns CONFLICT when the address is already taken", async () => {
    db.getUserByEmail.mockResolvedValueOnce({ id: 1, email: "taken@example.com" });

    expect(await attemptRegister({ email: "taken@example.com", password: "a-long-enough-password" }))
      .toBe("CONFLICT");
  });

  it("does NOT hash a password when the address is already taken", async () => {
    // The pre-check exists so the common case fails fast without spending scrypt.
    db.getUserByEmail.mockResolvedValueOnce({ id: 1, email: "taken@example.com" });
    await attemptRegister({ email: "taken@example.com", password: "a-long-enough-password" });

    expect(password.hashPassword).not.toHaveBeenCalled();
    expect(db.createPasswordUser).not.toHaveBeenCalled();
  });

  it("also returns CONFLICT when the row appears between the check and the insert", async () => {
    // Race safety: the unique openId is the real guard, so a lost race must still
    // be reported as CONFLICT rather than a raw database error.
    db.getUserByEmail.mockResolvedValueOnce(null);
    db.createPasswordUser.mockResolvedValueOnce({ ok: false, alreadyRegistered: true });

    expect(await attemptRegister({ email: "race@example.com", password: "a-long-enough-password" }))
      .toBe("CONFLICT");
  });

  it("refuses a weak password before touching the database", async () => {
    vi.mocked(password.assessPassword).mockReturnValueOnce({ ok: false, reason: "Too short." } as never);

    expect(await attemptRegister({ email: "x@example.com", password: "short" })).toBe("BAD_REQUEST");
    expect(db.getUserByEmail).not.toHaveBeenCalled();
  });

  it("creates a session cookie on success", async () => {
    db.getUserByEmail.mockResolvedValueOnce(null);
    db.createPasswordUser.mockResolvedValueOnce({ ok: true, alreadyRegistered: false });
    db.getUserByOpenId.mockResolvedValueOnce({ id: 7, openId: "local_x@example.com", email: "x@example.com", name: null, role: "user" });

    const ctx = makeCtx();
    await appRouter.createCaller(ctx).auth.register({ email: "x@example.com", password: "a-long-enough-password" } as never);

    expect(ctx.res.cookie).toHaveBeenCalled();
  });
});

describe("auth.login anti-enumeration (GO 167)", () => {
  it("answers UNAUTHORIZED for an address with no account", async () => {
    db.getUserByEmail.mockResolvedValueOnce(null);

    expect(await attemptLogin({ email: "ghost@example.com", password: "whatever-attempt" }))
      .toBe("UNAUTHORIZED");
  });

  it("answers UNAUTHORIZED for a wrong password", async () => {
    db.getUserByEmail.mockResolvedValueOnce({ id: 1, openId: "o", email: "a@b.c", passwordHash: "scrypt$fake$hash" });
    vi.mocked(password.verifyPassword).mockResolvedValueOnce({ ok: false } as never);

    expect(await attemptLogin({ email: "a@b.c", password: "wrong" })).toBe("UNAUTHORIZED");
  });

  it("returns the SAME code for both, so the endpoint cannot enumerate users", async () => {
    // If "no such account" and "wrong password" differed, an attacker could walk
    // a wordlist and learn which addresses are registered.
    db.getUserByEmail.mockResolvedValueOnce(null);
    const noAccount = await attemptLogin({ email: "ghost@example.com", password: "attempt" });

    db.getUserByEmail.mockResolvedValueOnce({ id: 1, openId: "o", email: "a@b.c", passwordHash: "h" });
    vi.mocked(password.verifyPassword).mockResolvedValueOnce({ ok: false } as never);
    const wrongPassword = await attemptLogin({ email: "a@b.c", password: "wrong" });

    expect(noAccount).toBe("UNAUTHORIZED");
    expect(wrongPassword).toBe("UNAUTHORIZED");
  });

  it("still runs a hash when no user exists, so the two paths cost the same time", async () => {
    db.getUserByEmail.mockResolvedValueOnce(null);
    await attemptLogin({ email: "ghost@example.com", password: "attempt" });

    expect(password.verifyPassword).toHaveBeenCalledWith("attempt", null);
  });

  it("issues a session when the password is right", async () => {
    db.getUserByEmail.mockResolvedValueOnce({ id: 1, openId: "local_real", email: "a@b.c", passwordHash: "h", name: null, role: "user" });
    vi.mocked(password.verifyPassword).mockResolvedValueOnce({ ok: true } as never);

    const ctx = makeCtx();
    await appRouter.createCaller(ctx).auth.login({ email: "a@b.c", password: "correct" } as never);

    expect(ctx.res.cookie).toHaveBeenCalled();
  });
});
