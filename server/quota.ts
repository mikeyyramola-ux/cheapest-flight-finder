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

export type QuotaProvider = {
  /** Storage key, stable across renames of the display label. */
  key: string;
  label: string;
  limit: number;
  /** "month" allowances reset every UTC month; "lifetime" allowances never reset. */
  period: "month" | "lifetime";
  /** False while a supplier is deliberately out of the live chain. */
  wired: boolean;
};

export const QUOTA_PROVIDERS: QuotaProvider[] = [
  { key: "scrappa", label: "Scrappa (Google Flights)", limit: 500, period: "month", wired: true },
  { key: "ignav", label: "Ignav", limit: 1000, period: "lifetime", wired: true },
  { key: "brightdata", label: "Bright Data", limit: 5000, period: "month", wired: false },
];

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
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
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
    // Percent is floored and the threshold is decided by exact integer arithmetic,
    // never by the rounded display value: 374/500 is 74.8%, which ROUNDS to 75 and
    // would have raised the flag one credit early - and worse, would have made the
    // reported "75%" and the `warn` flag disagree with each other.
    const percent = provider.limit > 0 ? Math.floor((used / provider.limit) * 100) : 0;
    const reachedThreshold = provider.limit > 0 && used * 100 >= provider.limit * QUOTA_WARN_PERCENT;
    return {
      key: provider.key,
      label: provider.label,
      used,
      limit: provider.limit,
      percent,
      period: quotaPeriodKey(provider, at),
      warn: reachedThreshold,
      exhausted: used >= provider.limit,
      wired: provider.wired,
      source: sourceByKey[provider.key] ?? source,
    };
  });
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

/** Records credits actually billed for a supplier. Called at the point a supplier
 *  answers with fares - never on a failure, because a failed request is not billed. */
export async function chargeQuota(supplierName: string, credits = 1): Promise<void> {
  const key = QUOTA_KEY_BY_SUPPLIER[supplierName];
  if (!key) return; // unmapped supplier: count nothing rather than something wrong
  const provider = QUOTA_PROVIDERS.find(item => item.key === key);
  if (!provider) return;

  const period = quotaPeriodKey(provider);
  memoryUsed.set(memoryKey(provider), (memoryUsed.get(memoryKey(provider)) ?? 0) + credits);

  try {
    const db = await getDb();
    if (!db) return;
    await bounded(() =>
      db
        .insert(creditUsage)
        .values({ provider: key, period, used: credits, creditLimit: provider.limit })
        .onDuplicateKeyUpdate({
          set: {
            used: sql`${creditUsage.used} + ${credits}`,
            creditLimit: provider.limit,
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
