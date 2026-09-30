import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { bounded } from "./quota";

/**
 * Observations: numbers a provider meters on our behalf but exposes through no free
 * API, recorded where the quota board can read them.
 *
 * Two different shapes live in the one small table, and the distinction is what keeps
 * both rows honest:
 *
 *  - TiDB's Request Units are shown only in TiDB Cloud's own console panel. Probed
 *    exhaustively on 2026-09-30 with an org API key minted for the purpose: the
 *    billing API answers in money only, all five public API specs carry no usage
 *    endpoint, and SQL access to metering tables is denied. The daily audit reads the
 *    console's "Capacity used this month" number and stores it here with the moment it
 *    was read, so the board can show it with its age - and withhold it when the age
 *    proves nobody has checked recently.
 *
 *  - Render's free plan retains CPU telemetry for only 7 days
 *    (render.com/docs/service-metrics: Hobby = 7 days), so a calendar month cannot be
 *    integrated from the API alone. Each successful read checkpoints the hours
 *    measured so far; the next read starts its integration from the checkpoint. The
 *    stored value is a total-to-a-moment (never an increment), so two readers racing
 *    write the same amount and no hour can be double-counted.
 *
 * Failure contract, same as every other board source: a missing table, a dead
 * database, or a stale reading come back as no number with a reason. An observation
 * store that is unreachable must turn into "not currently known", never into 0.
 */

export type BoardObservation = {
  /** Which board row this belongs to, e.g. "tidb-ru" or "render-instance-hours". */
  metricKey: string;
  /** The period the value belongs to, "YYYY-MM" in UTC. */
  periodKey: string;
  /** RU for tidb-ru; awake seconds for render-instance-hours. Never a guess. */
  used: number;
  /** When the observation was taken, as a Unix timestamp in seconds. */
  observedAtUnix: number;
  /** Where the number came from, stored so the row can say it out loud. */
  detail: string;
};

export type ObservationRead =
  | { observation: BoardObservation; reason: null }
  | { observation: null; reason: string };

function rowToObject(row: unknown): BoardObservation | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const metricKey = typeof record.metric_key === "string" ? record.metric_key : null;
  const periodKey = typeof record.period_key === "string" ? record.period_key : null;
  const used = Number(record.used);
  const observedAtUnix = Number(record.observed_at_unix);
  // A row that will not parse is treated exactly like a row that is not there: the
  // board would rather show no number than one whose units or age are a mystery.
  if (!metricKey || !periodKey || !Number.isFinite(used) || !Number.isFinite(observedAtUnix)) return null;
  return {
    metricKey,
    periodKey,
    used,
    observedAtUnix,
    detail: typeof record.detail === "string" ? record.detail : "",
  };
}

/** Best-effort read; never throws. `reason` explains any null. */
export async function readBoardObservation(metricKey: string): Promise<ObservationRead> {
  try {
    const db = await getDb();
    if (!db) return { observation: null, reason: "database not reachable at read time" };
    const result = (await bounded(() =>
      db.execute(sql`
        SELECT metric_key, period_key, used, observed_at_unix, detail
        FROM board_observations
        WHERE metric_key = ${metricKey}
      `),
    )) as unknown;
    if (!Array.isArray(result) || result.length === 0) {
      return { observation: null, reason: "observation store did not answer at read time" };
    }
    const dataRows = result[0];
    if (!Array.isArray(dataRows) || dataRows.length === 0) {
      return { observation: null, reason: "no observation recorded yet for this metric" };
    }
    const observation = rowToObject(dataRows[0]);
    if (!observation) return { observation: null, reason: "stored observation is unreadable" };
    return { observation, reason: null };
  } catch {
    return { observation: null, reason: "observation store unreadable at read time" };
  }
}

/**
 * Stores one observation, overwriting any previous one for the same metric.
 *
 * The write is absolute (a total as of `observedAtUnix`), never an increment, so
 * concurrent readers - or a reader racing a previous one's write - converge on the
 * same value instead of accumulating duplicate hours. Best-effort by design: a
 * checkpoint that could not be stored only means the next read integrates a slightly
 * longer window, which the 7-day retention still allows for a long time.
 */
export async function saveBoardObservation(observation: BoardObservation): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await bounded(() =>
      db.execute(sql`
        INSERT INTO board_observations (metric_key, period_key, used, observed_at_unix, detail)
        VALUES (${observation.metricKey}, ${observation.periodKey}, ${observation.used}, ${observation.observedAtUnix}, ${observation.detail})
        ON DUPLICATE KEY UPDATE
          period_key = ${observation.periodKey},
          used = ${observation.used},
          observed_at_unix = ${observation.observedAtUnix},
          detail = ${observation.detail}
      `),
    );
  } catch {
    // Deliberately swallowed: a stored checkpoint is an optimisation of the read
    // path, and losing one degrades to a longer integration window, not to a wrong
    // number. The freshness rule below still guards whatever is stored.
  }
}

function formatUtc(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "2026-09-30 14:52 UTC" - the display form for an observation's moment. */
export const formatObservationUtc = formatUtc;

export type ObservationEvaluation = {
  /** null when the observation is missing, stale, or unreadable - never a fallback 0. */
  used: number | null;
  reason: string | null;
  observedAtUnix: number | null;
  detail: string | null;
};

/**
 * Pure: decides whether one stored observation may be presented as current.
 *
 * Fresh enough → the number with its provenance. Too old → withheld with the age in
 * the reason, because a quota figure nobody has refreshed in days is exactly the kind
 * of stale green that lets a ceiling be crossed unnoticed.
 */
export function evaluateObservation(
  read: ObservationRead,
  at: Date,
  maxAgeMs: number,
): ObservationEvaluation {
  if (!read.observation) {
    return { used: null, reason: read.reason, observedAtUnix: null, detail: null };
  }
  const obs = read.observation;
  const ageMs = at.getTime() - obs.observedAtUnix * 1000;
  if (ageMs > maxAgeMs || ageMs < -60_000) {
    // A clock skew of up to a minute is tolerated (two machines, same reality); past
    // that an observation is either stale or from the future - neither is "now".
    const ageHours = (ageMs / 3_600_000).toFixed(1);
    return {
      used: null,
      reason: `Last observation was ${ageHours} h old (recorded ${formatUtc(obs.observedAtUnix)}) - withheld rather than shown as current. ${obs.detail}`,
      observedAtUnix: obs.observedAtUnix,
      detail: obs.detail,
    };
  }
  return { used: obs.used, reason: null, observedAtUnix: obs.observedAtUnix, detail: obs.detail };
}

/** Reads one stored observation and applies the freshness rule above. */
export async function measureConsoleObservation(
  metricKey: string,
  at: Date,
  maxAgeMs: number,
): Promise<ObservationEvaluation> {
  const read = await readBoardObservation(metricKey);
  return evaluateObservation(read, at, maxAgeMs);
}
