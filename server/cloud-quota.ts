import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { bounded, loadQuotaStatus, QUOTA_WARN_PERCENT, type QuotaStatus } from "./quota";

/**
 * The quota board: every outside service Fareloop cannot run without, with the one
 * number that matters - how much of a finite allowance is already spent.
 *
 * Why this is wider than quota.ts. That file tracks supplier credits because a spent
 * pool is the direct cause of a customer's alert not going out. But supplier credits
 * are not the only ceiling this product sits under: TiDB stops accepting connections
 * when the free-tier allowance is gone, and Vercel stops serving once its plan limit
 * is reached. Those failures arrive just as suddenly and were not being watched by
 * anything. An operator should be able to see all of them in one frame rather than
 * discovering each one the day it bites.
 *
 * Two rules this file exists to keep:
 *
 *  1. A limit is never invented. Every ceiling carries the document it came from in
 *     `limitSource`. Where no limit is published (or it does not apply), the limit is
 *     null and the row says so rather than borrowing a plausible-looking number.
 *  2. Unwatched never looks like unused. `used` is null when we hold no feed for a
 *     metric - not 0. A zero here would read as "we have spent nothing", which is a
 *     claim we cannot make about a counter we do not keep, and it is precisely the
 *     false reassurance that lets a quota problem go unnoticed.
 *
 * Everything is read-only and nothing is charged: this endpoint reads the ledger and
 * the database catalogue, and can never spend a credit or send an alert.
 */

const GIB = 1024 ** 3;

export type CloudCategory = "supplier" | "hosting" | "database" | "payments";
/** How `used` is obtained: our own credit ledger, a SQL read, or no feed at all. */
export type CloudFeed = "ledger" | "sql" | "none";
export type CloudPeriod = "month" | "lifetime" | "day" | "standing" | null;

export type CloudServiceRow = {
  key: string;
  service: string;
  category: CloudCategory;
  /** What the number counts, e.g. "Search credits" or "Row storage". */
  metric: string;
  unit: string;
  /** null = no ceiling published (or none applies). See `limitSource`. */
  limit: number | null;
  period: CloudPeriod;
  /** null = we hold no feed. Never 0 by omission. */
  used: number | null;
  /** Integer percent used, floored, and only when both sides are known. */
  percent: number | null;
  warn: boolean;
  exhausted: boolean;
  /** False while a supplier is deliberately out of the live chain (E14's meaning). */
  wired: boolean;
  feed: CloudFeed;
  source: "database" | "instance-memory" | "none";
  /** The document or ledger the ceiling came from. Required: no unsourced limit. */
  limitSource: string;
  note: string | null;
};

type CloudServiceDef = Omit<CloudServiceRow, "used" | "percent" | "warn" | "exhausted" | "source" | "wired">;

/**
 * Services with a published ceiling but, as yet, no feed we can read for free.
 *
 * They are listed anyway. A quota nobody is watching is not made safer by leaving it
 * off the board - the row is the record that the blind spot exists.
 */
export const CLOUD_SERVICE_DEFS: CloudServiceDef[] = [
  {
    key: "tidb-storage",
    service: "TiDB Cloud",
    category: "database",
    metric: "Row storage",
    unit: "bytes",
    limit: 5 * GIB,
    period: "standing",
    feed: "sql",
    limitSource: "TiDB Cloud free-tier published quota - 5 GiB row storage (docs.pingcap.com)",
    note: "Read from information_schema at request time; the catalogue reports an estimate, not a bill line.",
  },
  {
    key: "tidb-ru",
    service: "TiDB Cloud",
    category: "database",
    metric: "Request Units",
    unit: "RU",
    limit: 50_000_000,
    period: "month",
    feed: "none",
    limitSource: "TiDB Cloud free-tier published quota - 50 million RU per month (docs.pingcap.com)",
    note: "RU consumption is metered by TiDB Cloud and is not exposed through SQL, so this ceiling cannot be watched from in here. Reaching it denies new connections until the month rolls over.",
  },
  {
    key: "vercel-data-transfer",
    service: "Vercel",
    category: "hosting",
    metric: "Fast Data Transfer",
    unit: "GB",
    limit: 100,
    period: "month",
    feed: "none",
    limitSource: "Vercel Hobby plan published limit - 100 GB per month (vercel.com/docs/limits)",
    note: "Usage is reported in the Vercel dashboard behind an account token this project does not hold, so the figure is a ceiling, not a measurement.",
  },
  {
    key: "vercel-deployments",
    service: "Vercel",
    category: "hosting",
    metric: "Deployments",
    unit: "deploys",
    limit: 100,
    period: "day",
    feed: "none",
    limitSource: "Vercel Hobby plan published limit - 100 deployments per day (vercel.com/docs/limits)",
    note: "Same missing feed as the row above: the limit is known, the running count is not.",
  },
  {
    key: "paypal-allowance",
    service: "PayPal",
    category: "payments",
    metric: "Usage allowance",
    unit: "",
    limit: null,
    period: null,
    feed: "none",
    limitSource: "No allowance applies - PayPal bills per transaction",
    note: "Listed so the inventory of services we depend on is complete. There is no pool here that can run dry.",
  },
];

/**
 * Pure: turns one definition plus a measurement into a board row. Kept free of I/O so
 * the threshold can be asserted exactly rather than approximated through a mock.
 *
 * `used` stays null when there is no feed, and percent/warn/exhausted stay false or
 * null rather than being computed off a number we never observed.
 */
export function buildCloudRow(
  def: CloudServiceDef,
  used: number | null,
  source: CloudServiceRow["source"],
  extras: { wired?: boolean } = {},
): CloudServiceRow {
  // A ceiling of zero or below is not a ceiling, so it is treated as absent rather
  // than producing a division by zero or a permanent 100%.
  const ceiling = def.limit !== null && def.limit > 0 ? def.limit : null;
  let percent: number | null = null;
  let warn = false;
  let exhausted = false;
  if (used !== null && ceiling !== null) {
    // Same rule as E14: percent is floored and the threshold is decided by exact
    // integer arithmetic, never by the rounded display value, so a row cannot report
    // "75%" while its own `warn` flag disagrees with it.
    percent = Math.floor((used / ceiling) * 100);
    warn = used * 100 >= ceiling * QUOTA_WARN_PERCENT;
    exhausted = used >= ceiling;
  }
  return {
    ...def,
    used,
    percent,
    warn,
    exhausted,
    wired: extras.wired ?? true,
    source: used !== null ? source : "none",
  };
}

/**
 * Bytes held by our own schema, read from the catalogue rather than the console.
 *
 * This is the one number that compounds on its own: every nightly scan appends a
 * reading per tracked route, so storage is the ceiling this product grows towards.
 */
async function measureStorageBytes(): Promise<{ used: number | null; source: CloudServiceRow["source"] }> {
  try {
    const db = await getDb();
    if (!db) return { used: null, source: "none" };
    // Drizzle's MySQL `execute` hands back the driver's [rows, fields] pair and types
    // position 0 as an insert result, which a SELECT is not. The shape is therefore
    // narrowed at runtime rather than trusted from the type, so a driver change cannot
    // turn into "storage is 0 bytes" on a board that is supposed to be evidence.
    const result = (await bounded(() =>
      db.execute(sql`
        SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
      `),
    )) as unknown;
    if (!Array.isArray(result) || result.length === 0) return { used: null, source: "none" };
    const dataRows = result[0];
    if (!Array.isArray(dataRows) || dataRows.length === 0) return { used: null, source: "none" };
    const bytes = Number((dataRows[0] as { bytes?: unknown } | null)?.bytes);
    if (!Number.isFinite(bytes)) return { used: null, source: "none" };
    return { used: bytes, source: "database" };
  } catch {
    // A measurement we could not take reports as no measurement at all.
    return { used: null, source: "none" };
  }
}

/**
 * The full board: supplier credits first (they are what an alert depends on), then
 * every other service with a published ceiling.
 *
 * Never throws and never blocks: each source is resolved independently, so a ledger
 * that is unreachable costs that row its number and leaves the rest of the board
 * intact. An ops report that fails entirely is one nobody looks at twice.
 */
export async function loadCloudBoard(at: Date = new Date()): Promise<CloudServiceRow[]> {
  let suppliers: QuotaStatus[] = [];
  try {
    suppliers = await loadQuotaStatus(at);
  } catch {
    suppliers = [];
  }

  const storage = await measureStorageBytes();

  const rows: CloudServiceRow[] = suppliers.map(status =>
    buildCloudRow(
      {
        key: `${status.key}-credits`,
        service: status.label,
        category: "supplier",
        metric: "Search credits",
        unit: "credits",
        limit: status.limit,
        period: status.period === "lifetime" ? "lifetime" : "month",
        feed: "ledger",
        limitSource: "Credit ledger we write at charge time - no supplier publishes a usage endpoint",
        note: status.wired
          ? null
          : "Held in reserve: this supplier is not wired into the live search chain, so the pool only drains if we deliberately route to it.",
      },
      status.used,
      status.source,
      { wired: status.wired },
    ),
  );

  for (const def of CLOUD_SERVICE_DEFS) {
    if (def.key === "tidb-storage") {
      rows.push(buildCloudRow(def, storage.used, storage.source));
      continue;
    }
    rows.push(buildCloudRow(def, null, "none"));
  }

  return rows;
}

/** Roll-up for the header of the board. Computed here so the client cannot disagree. */
export type CloudBoardSummary = {
  total: number;
  /** Rows we can actually read a usage figure for. */
  monitored: number;
  /** Rows with a ceiling and no feed - the gaps that cause surprises. */
  blindSpots: number;
  warn: number;
  exhausted: number;
  unwired: number;
};

export function summariseCloudBoard(rows: CloudServiceRow[]): CloudBoardSummary {
  return {
    total: rows.length,
    monitored: rows.filter(row => row.percent !== null).length,
    blindSpots: rows.filter(row => row.limit !== null && row.feed === "none").length,
    warn: rows.filter(row => row.warn).length,
    exhausted: rows.filter(row => row.exhausted).length,
    unwired: rows.filter(row => !row.wired).length,
  };
}
