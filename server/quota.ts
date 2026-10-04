import { sql } from "drizzle-orm";
import { creditUsage } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Supplier credit quotas - the early-warning system behind escalation E14.
 *
 * Why this exists: not one of our suppliers exposes a usage endpoint, so there is no
 * way to ask Scrappa "how many credits do I have left". The only honest counter is
 * one we keep ourselves, at the exact moment a request is billed. Without it the
 * first warning that a pool is empty is a customer's alert going unsent - which is
 * precisely the failure this business cannot have.
 *
 * E14 threshold: flag at 75% of an allowance, while there is still a quarter of the
 * pool left to act on. E3 remains the hard tripwire for the alert pool hitting zero;
 * E14 is the warning that makes E3 avoidable.
 *
 * Three suppliers are tracked, not two:
 *   - Scrappa              500 / month   (refills - spend it first)
 *   - Ignav                1,000 lifetime (never refills - the reserve)
 *   - Bright Data          5,000 / month  (not wired into the live chain yet, tracked
 *                                          anyway so its pool can never surprise us)
 *
 * Storage is optional in the same style as price-store: no DATABASE_URL means the
 * count lives in this instance's memory only, and every failure is swallowed rather
 * than thrown - a quota bookkeeping error must never cost a customer a search.
 */

export const QUOTA_WARN_PERCENT = 75;

/**
 * PROPOSAL 20 / CONFIRM 20: the $10 Scrappa Starter pack - bought once, 33,000
 * credits, valid 12 months (scrappa.co/pricing), no auto-renew.
 *
 * Activated on the owner's CONFIRM 20, 2026-10-04 UTC. Those two fields are the
 * whole activation step: nothing here is derived from a stored expiry column, so
 * turning the pack on never needed a migration, a cron or a schema change.
 *
 * `issuedAt` is UTC to match every other period in this module - quotaPeriodKey
 * reads getUTCFullYear/getUTCMonth, and packPeriodKey parses this string as UTC
 * midnight. The owner's local date at confirmation was 2026-10-05 IST; both dates
 * give the same `pack-2026-10` bucket and differ only by a day of expiry, so a
 * purchase made on his local date is a one-field correction.
 */
export const SCRAPPA_PACK = {
  /** CONFIRM 20: 33,000 credits. Set to 0 to withdraw the pack. */
  limit: 33_000,
  /** CONFIRM 20: issue date. Expiry and the period key derive from this alone. */
  issuedAt: "2026-10-04",
  /** Months the pack stays valid from its issue date. */
  validMonths: 12,
};

export type QuotaProvider = {
  /** Storage key, stable across renames of the display label. */
  key: string;
  label: string;
  limit: number;
  /** "month" allowances reset every UTC month; "lifetime" allowances never reset;
   *  "pack" allowances run from their issue date and never reset. */
  period: "month" | "lifetime" | "pack";
  /** False while a supplier is deliberately out of the live chain. */
  wired: boolean;
};

export const QUOTA_PROVIDERS: QuotaProvider[] = [
  { key: "scrappa", label: "Scrappa (Google Flights)", limit: 500, period: "month", wired: true },
  { key: "scrappa-pack", label: "Scrappa pack", limit: SCRAPPA_PACK.limit, period: "pack", wired: true },
  { key: "ignav", label: "Ignav", limit: 1000, period: "lifetime", wired: true },
  { key: "brightdata", label: "Bright Data", limit: 5000, period: "month", wired: false },
];

/** The two rows that are, in reality, one Scrappa balance. Nothing but the breaker
 *  and the board's total should ever read one of them without the other. */
export const SCRAPPA_POOL_KEYS = ["scrappa", "scrappa-pack"];

/** Supplier name as stamped onto an offer -> quota key. Unknown suppliers are never
 *  guessed into a bucket: an unmapped supplier simply is not counted. */
const QUOTA_KEY_BY_SUPPLIER: Record<string, string> = {
  "Google Flights": "scrappa",
  Ignav: "ignav",
  "Bright Data": "brightdata",
};

/** `2026-09` for a refilling pool, `lifetime` for a one-time pool. UTC, because the
 *  supplier's own reset is not going to be counted from the customer's timezone. */
export function quotaPeriodKey(provider: QuotaProvider, at: Date = new Date()): string {
  if (provider.period === "lifetime") return "lifetime";
  if (provider.period === "pack") return packPeriodKey();
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** PROPOSAL 20: the pack's period key is pinned to the month it was BOUGHT, never to
 *  `at`. That one line is why a month rollover cannot re-grant it - on the 1st the
 *  free row moves to `2026-11` and starts empty, while the pack row stays on
 *  `pack-2026-10` and keeps every credit already spent against it. */
function packPeriodKey(): string {
  if (!SCRAPPA_PACK.issuedAt) return "pack-none"; // unpurchased: nothing to bucket
  const issued = new Date(`${SCRAPPA_PACK.issuedAt}T00:00:00Z`);
  if (Number.isNaN(issued.getTime())) return "pack-none";
  return `pack-${issued.getUTCFullYear()}-${String(issued.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * PROPOSAL 20: what a pool is worth RIGHT NOW.
 *
 * A monthly pool is worth its limit; a pack is worth its limit only while it is
 * unexpired, and nothing at all before purchase or after expiry. Expiry therefore
 * falls out of every total with no expiry column, no cron and no migration - the
 * number becomes 0 and stops being counted, which is also exactly what the 75%
 * breaker should see.
 */
export function availableLimit(provider: QuotaProvider, at: Date = new Date()): number {
  if (provider.period !== "pack") return provider.limit;
  // SCRAPPA_PACK.limit is the authority for packs rather than the row's own limit
  // field, so CONFIRM 20 is a one-field edit that reaches every consumer at once.
  const nominal = SCRAPPA_PACK.limit;
  if (!nominal || !SCRAPPA_PACK.issuedAt) return 0;
  const issued = new Date(`${SCRAPPA_PACK.issuedAt}T00:00:00Z`);
  if (Number.isNaN(issued.getTime())) return 0;
  const expiry = Date.UTC(
    issued.getUTCFullYear(),
    issued.getUTCMonth() + SCRAPPA_PACK.validMonths,
    issued.getUTCDate(),
  );
  return at.getTime() >= expiry ? 0 : nominal;
}

export type QuotaStatus = {
  key: string;
  label: string;
  used: number;
  limit: number;
  /** Integer percent used, so the report and the escalation quote the same number. */
  percent: number;
  period: string;
  /** True once the allowance reaches the E14 threshold. */
  warn: boolean;
  /** True once nothing is left. */
  exhausted: boolean;
  wired: boolean;
  /** Where the number came from. "instance-memory" means the database was not
   *  reachable, so this is one instance's view rather than the month-wide total. */
  source: "database" | "instance-memory" | "none";
};

/**
 * Pure: builds quota rows from a `key -> credits used` map. Kept free of I/O so the
 * 75% boundary can be tested exactly rather than approximated through a mock.
 */
export function buildQuotaStatus(
  usedByKey: Record<string, number>,
  source: QuotaStatus["source"],
  at: Date = new Date(),
  sourceByKey: Record<string, QuotaStatus["source"]> = {},
): QuotaStatus[] {
  return QUOTA_PROVIDERS.map(provider => {
    const used = Math.max(0, usedByKey[provider.key] ?? 0);
    // PROPOSAL 20: the LIMIT comes from availableLimit, so an unpurchased or expired
    // pack reports itself as worth nothing rather than as its nominal 33,000.
    const limit = availableLimit(provider, at);
    // Percent is floored and the threshold is decided by exact integer arithmetic,
    // never by the rounded display value: 374/500 is 74.8%, which ROUNDS to 75 and
    // would have raised the flag one credit early - and worse, would have made the
    // reported "75%" and the `warn` flag disagree with each other.
    const percent = limit > 0 ? Math.floor((used / limit) * 100) : 0;
    const reachedThreshold = limit > 0 && used * 100 >= limit * QUOTA_WARN_PERCENT;
    return {
      key: provider.key,
      label: provider.label,
      used,
      limit,
      percent,
      period: quotaPeriodKey(provider, at),
      warn: reachedThreshold,
      // A pool worth 0 is not empty, it is not in play. Reporting an unpurchased pack
      // as `exhausted` would raise a permanent red flag that can never be cleared and
      // would bury the one genuine "this pool ran out" warning underneath it.
      exhausted: limit > 0 && used >= limit,
      wired: provider.wired,
      source: sourceByKey[provider.key] ?? source,
    };
  });
}

/**
 * PROPOSAL 20: the two Scrappa rows read as ONE pool, because that is what they are.
 *
 * The free allowance refills monthly and the pack does not, so neither row alone is
 * the balance that empties - only their sum is. This is the single function the
 * spend breaker consults, so the number that blocks a search and the number the
 * board reports are produced by the same arithmetic and cannot drift apart.
 */
export function scrappaCombined(rows: QuotaStatus[]): {
  used: number;
  limit: number;
  percent: number;
  warn: boolean;
  exhausted: boolean;
} {
  const pools = rows.filter(row => SCRAPPA_POOL_KEYS.includes(row.key));
  const used = pools.reduce((sum, row) => sum + row.used, 0);
  // Each row already carries its *available* limit, so an expired pack contributes 0
  // here without this function needing to know what an expiry date is.
  const limit = pools.reduce((sum, row) => sum + row.limit, 0);
  return {
    used,
    limit,
    percent: limit > 0 ? Math.floor((used / limit) * 100) : 0,
    warn: limit > 0 && used * 100 >= limit * QUOTA_WARN_PERCENT,
    exhausted: limit > 0 && used >= limit,
  };
}

// Per-instance fallback. Serverless memory is not shared, so this alone can only ever
// report one container's spend - the database row is the month-wide truth, and the
// higher of the two is reported so a failed write cannot hide real consumption.
const memoryUsed = new Map<string, number>();

/**
 * Bounds every quota database call.
 *
 * The quota ledger is a warning system, not the product: if TiDB hangs, a search
 * must not hang with it and the cron must still answer on time. On timeout the
 * in-memory count is used instead, and `source` reports that honestly.
 */
const QUOTA_DB_TIMEOUT_MS = 4_000;

export async function bounded<T>(work: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Rejections are absorbed here rather than left on the raced promise: after a
  // timeout wins the race, a later rejection would otherwise surface as an
  // unhandled rejection and take down a search that already has its answer.
  const attempt = work().then(
    value => value,
    () => null,
  );
  try {
    return await Promise.race([
      attempt,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), QUOTA_DB_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function memoryKey(provider: QuotaProvider, at: Date = new Date()) {
  return `${provider.key}|${quotaPeriodKey(provider, at)}`;
}

/**
 * PROPOSAL 20: which of the two Scrappa pools absorbs this credit.
 *
 * Free first. The free pool refills next month and the pack does not, so spending
 * the pack early would burn the one allowance that carries an expiry date.
 *
 * The decision reads only the in-memory counter, costing no extra database round
 * trip - and it does not need one: because the breaker SUMS both pools, a credit
 * filed on the wrong side still counts identically in the total. Routing decides
 * which row DISPLAYS a credit, never WHETHER it is counted.
 */
function pickPool(supplierKey: string): QuotaProvider | undefined {
  const free = QUOTA_PROVIDERS.find(item => item.key === supplierKey);
  if (!free) return undefined;
  const pack = QUOTA_PROVIDERS.find(item => item.key === `${supplierKey}-pack`);
  // No pack, or one not yet purchased / already expired: there is nowhere to spill
  // to, so every credit lands on the free pool as it always did.
  if (!pack || availableLimit(pack) <= 0) return free;
  const spentThisMonth = memoryUsed.get(memoryKey(free)) ?? 0;
  return spentThisMonth >= free.limit ? pack : free;
}

/** Records credits actually billed for a supplier. Called at the point a supplier
 *  answers with fares - never on a failure, because a failed request is not billed. */
export async function chargeQuota(supplierName: string, credits = 1): Promise<void> {
  const key = QUOTA_KEY_BY_SUPPLIER[supplierName];
  if (!key) return; // unmapped supplier: count nothing rather than something wrong
  const provider = pickPool(key);
  if (!provider) return;

  const period = quotaPeriodKey(provider);
  memoryUsed.set(memoryKey(provider), (memoryUsed.get(memoryKey(provider)) ?? 0) + credits);

  try {
    const db = await getDb();
    if (!db) return;
    const limit = availableLimit(provider);
    await bounded(() =>
      db
        .insert(creditUsage)
        .values({ provider: provider.key, period, used: credits, creditLimit: limit })
        .onDuplicateKeyUpdate({
          set: {
            used: sql`${creditUsage.used} + ${credits}`,
            creditLimit: limit,
          },
        }),
    );
  } catch {
    // Bookkeeping must never break a search. The memory counter above still holds
    // this instance's spend, and buildQuotaStatus reports the higher of the two.
  }
}

/**
 * Quota position for every tracked supplier.
 *
 * Reported with `source` so a number can never masquerade as month-wide truth when
 * it is only one instance's view. With no storage configured the status still comes
 * back (from memory) rather than pretending the pools are unused.
 */
export async function loadQuotaStatus(at: Date = new Date()): Promise<QuotaStatus[]> {
  const usedByKey: Record<string, number> = {};
  const sourceByKey: Record<string, QuotaStatus["source"]> = {};
  let overall: QuotaStatus["source"] = "none";

  try {
    const db = await getDb();
    if (db) {
      const periods = Array.from(new Set(QUOTA_PROVIDERS.map(provider => quotaPeriodKey(provider, at))));
      const rows = await bounded(() => db.select().from(creditUsage));
      if (rows) {
        for (const row of rows) {
          if (!periods.includes(row.period)) continue;
          usedByKey[row.provider] = Math.max(usedByKey[row.provider] ?? 0, Number(row.used) || 0);
        }
        overall = "database";
      }
    }
  } catch {
    overall = "none";
  }

  for (const provider of QUOTA_PROVIDERS) {
    const fromDb = usedByKey[provider.key] ?? 0;
    const inMemory = memoryUsed.get(memoryKey(provider, at)) ?? 0;
    usedByKey[provider.key] = Math.max(fromDb, inMemory);
    // Per-row, not per-report: the ledger proves a row's own provenance. If memory
    // is ahead of the table, that row's write did not land, so it must say
    // "instance-memory" instead of borrowing the database's authority.
    sourceByKey[provider.key] =
      inMemory > fromDb ? "instance-memory" : fromDb > 0 ? "database" : overall === "database" ? "database" : "none";
  }

  return buildQuotaStatus(usedByKey, overall, at, sourceByKey);
}
