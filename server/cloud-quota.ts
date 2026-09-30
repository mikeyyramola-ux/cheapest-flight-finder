import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { bounded, loadQuotaStatus, QUOTA_WARN_PERCENT, type QuotaStatus } from "./quota";
import { probeRenderEngine } from "./render-probe";
import { measureVercelDeployments } from "./vercel-usage";

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
/** How `used` is obtained: our own credit ledger, a SQL read, a live HTTP probe,
 *  a provider's own REST API, or no feed at all. */
export type CloudFeed = "ledger" | "sql" | "probe" | "api" | "none";
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
  source: "database" | "instance-memory" | "probe" | "api" | "none";
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
    limitSource: "TiDB Cloud Starter free quota - 50 million RU per month per instance, first 5 instances (pingcap.com/tidb-cloud-starter-pricing-details, verified 2026-09-30)",
    note: "Metered by TiDB Cloud and not exposed through SQL (checked against the current docs) - the viewers are the console's Usage This Month panel and the cluster Metrics page. The TiDB Cloud API's billing endpoint reads a month's bill but needs an API key this project does not hold, so no key = no reading. Reaching the quota throttles the instance (new connections denied) until the month rolls over.",
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
    limitSource: "Vercel Hobby free allotment - first 100 GB Fast Data Transfer per month (vercel.com/docs/limits/fair-use-guidelines, typical monthly usage table, updated 2026-09-14)",
    note: "The token is not the problem: Vercel's own usage API (/v1/usage) answered plan_upgrade_required when queried from this Hobby team (verified 2026-09-30), so reading Fast Data Transfer programmatically is a Pro/Enterprise feature. The only viewer at the $0 plan is the dashboard Usage page, and no number is claimed from in here.",
  },
  {
    key: "vercel-deployments",
    service: "Vercel",
    category: "hosting",
    metric: "Deployments",
    unit: "deploys",
    limit: 100,
    period: "day",
    feed: "api",
    limitSource: "Vercel Hobby plan published limit - 100 deployments created per day (vercel.com/docs/limits; rate limit: 100 per rolling 86400 s, verified 2026-09-30)",
    note: "Counted live at page load from Vercel's own deployments API over the rolling 24-hour window that defines the limit, so this row means exactly what Vercel means by it. A failed read shows no number, never a zero.",
  },
  {
    key: "render-instance-hours",
    service: "Render",
    category: "hosting",
    metric: "Free instance hours",
    unit: "hours",
    limit: 750,
    period: "month",
    feed: "none",
    limitSource: "Render free plan published ceiling - 750 Free instance hours per workspace per calendar month; exhaustion suspends every free web service until next month (render.com/docs/free)",
    note: "GitHub Actions pings /api/cloud-tick every 30 minutes (quota-aware relay, ping.yml :13/:43) and our cloud mirror reads the engine every 15 minutes, so it runs near-continuous: an always-awake month spends 720-744 of the 750 hours (24 h x 30/31 days) - little headroom. No Render API key is held here, and Render's public API spec carries no billing or usage endpoint at all (verified 2026-09-30 - metrics only), so the only viewer of this counter is Render's billing page and no number is claimed from in here.",
  },
  {
    key: "render-engine",
    service: "Render",
    category: "hosting",
    metric: "Engine ledger freshness",
    unit: "min",
    limit: 15,
    period: "standing",
    feed: "probe",
    limitSource: "PRIME's own engine rule, not a Render ceiling - the primary engine (prime-enterprise) writes its ledger on every real event, so state older than 15 minutes means the daemons are down while Flask still answers 200 (the 09-24/25 overnight failure)",
    note: "Read live at page load from the engine's own /api/state ledger timestamp. When the probe cannot reach it, the row reports no number instead of a guess.",
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
  extras: { wired?: boolean; note?: string | null } = {},
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
    note: extras.note ?? def.note,
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
  // The four sources are independent by design and are read in parallel: a
  // board built from sequential timeouts could stack bounded(4 s) + bounded(4 s)
  // + probe(6 s) past the serverless function limit and fail the whole request,
  // which is the exact "wire dies, board dies" outcome the board exists to avoid.
  const [suppliers, storage, probe, deployments] = await Promise.all([
    loadQuotaStatus(at).catch(() => [] as QuotaStatus[]),
    measureStorageBytes(),
    probeRenderEngine(at),
    measureVercelDeployments(at).catch(() => ({
      used: null,
      reason: "Vercel deployments read failed - the count is withheld, never assumed.",
    })),
  ]);

  const rows: CloudServiceRow[] = suppliers.map(status => {
    // Rule 2 of this file, enforced at the mapping layer: `loadQuotaStatus` reports
    // used = 0 with source = "none" when TiDB was unreachable and this instance
    // remembers no charges of its own. Rendering that as 0/500 "Healthy" would be
    // the board's worst possible lie - a false green during the very outage it is
    // supposed to expose - so an unobserved supplier count becomes null, not 0.
    const unobserved = status.source === "none";
    const reserveNote = status.wired
      ? null
      : "Held in reserve: this supplier is not wired into the live search chain, so the pool only drains if we deliberately route to it.";
    const unreadNote = "Credit ledger was unreachable at read time - no number is claimed rather than a false zero.";
    return buildCloudRow(
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
        note: [reserveNote, unobserved ? unreadNote : null].filter(Boolean).join(" ") || null,
      },
      unobserved ? null : status.used,
      status.source,
      { wired: status.wired },
    );
  });

  for (const def of CLOUD_SERVICE_DEFS) {
    if (def.key === "tidb-storage") {
      rows.push(buildCloudRow(def, storage.used, storage.source));
      continue;
    }
    if (def.key === "render-engine") {
      rows.push(
        buildCloudRow(def, probe.used, probe.used !== null ? "probe" : "none", {
          note: probe.reason ?? def.note,
        }),
      );
      continue;
    }
    if (def.key === "vercel-deployments") {
      // Same honesty shape as the probe: a successful read carries the count, a
      // failed one carries the reason and no number at all - never a zero that
      // would read as "nothing deployed today" when the API was the thing that
      // failed.
      rows.push(
        buildCloudRow(def, deployments.used, deployments.used !== null ? "api" : "none", {
          note: deployments.reason ?? def.note,
        }),
      );
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
