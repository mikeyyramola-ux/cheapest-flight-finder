import { readBoardObservation, saveBoardObservation, type BoardObservation } from "./observations";
import { bounded } from "./quota";

/**
 * Render's free instance-hour counter, measured from Render itself.
 *
 * Render publishes the ceiling (750 Free instance hours per workspace per calendar
 * month, render.com/docs/free) but exposes no billing or usage endpoint in its public
 * API - verified against the OpenAPI spec on 2026-09-30. What the API does expose is
 * the service's own metrics, and from those the hour counter is reconstructed:
 *
 *   hours = awake time. A free instance consumes an hour only while it is running
 *   (Render explicitly does not charge spun-down time), and while it runs it emits a
 *   CPU sample every 300 seconds. Summing the intervals between consecutive samples
 *   within each instance's lifetime therefore integrates exactly the quantity Render
 *   bills - spun-down gaps read as no samples at all, and the gap cap keeps a
 *   monitoring hiccup from ever being counted as awake time.
 *
 * Validated against the authority it mirrors: on 2026-09-30 this integration read
 * 92.25 h for the month against the 92.65 h shown on Render's billing page (0.4%
 * below - the boot sliver between an instance starting and its first sample). The
 * billing page stays the authority; this row is labelled as the derived measurement
 * it is.
 *
 * The one gap in the method is retention: Render keeps free-plan metrics for only
 * 7 days (render.com/docs/service-metrics). A checkpoint of the hours already
 * measured is therefore stored after every successful read (see observations.ts) and
 * the next read integrates from there. When no checkpoint can cover the missing part
 * of the month, the reading comes back withheld with the reason - a partial month
 * presented as the whole month would be the exact quiet undercount this board exists
 * to prevent.
 *
 * Failure contract (same as vercel-usage.ts): never throws, never guesses. Missing
 * key, rejected fetch, unparsable body, or an unreachable checkpoint all resolve to
 * used = null with a reason - never to 0, which would read as "we have spent nothing"
 * during the very failure that hid the count.
 */

export type RenderHoursReading = {
  /** Month-to-date hours, or null when no honest figure exists. */
  used: number | null;
  /** Why the number is missing. null when the read succeeded. */
  reason: string | null;
  /** New checkpoint to persist after a successful read (total awake seconds). */
  checkpoint: BoardObservation | null;
};

// Public identifiers (they appear in dashboard URLs), not secrets. The key itself
// comes from the RENDER_API_KEY env var this project's function carries.
const SERVICE_ID = "srv-daqnfpuk1f9s73cps26g";
// Service creation, read from GET /v1/services on 2026-09-30. Before this moment the
// instance could not have consumed an hour, so month prefixes older than the service
// are provably zero rather than unknown - which is what lets the first read of a
// partially-retained month still be complete.
const SERVICE_CREATED_AT_MS = Date.parse("2026-09-24T19:20:08.460654Z");
const RESOLUTION_SECONDS = 300;
/** Free-plan retention is 7 days; 6.5 leaves margin for scrape timing and clocks. */
const RETENTION_MS = 6.5 * 24 * 60 * 60 * 1000;
/**
 * The widest gap that can still be one continuous run of 300 s scrapes plus slack.
 * Anything larger is downtime (the service spun down, or a scrape was lost), and
 * downtime must never be integrated as awake time.
 */
const GAP_CAP_MS = 750 * 1000;

export const RENDER_HOURS_KEY = "render-instance-hours";

type MetricSeries = { values?: Array<{ timestamp?: unknown }> | null };

/**
 * Pure: awake seconds recovered from CPU sample timestamps.
 *
 * Per instance series (a series is one instance lifetime - free services churn an
 * instance id on each spin-up), consecutive samples are spaced by the 300 s
 * resolution, so the sum of the gaps between them is the time the instance spent
 * awake. Gaps beyond the cap are downtime or corrupt data and contribute nothing;
 * timestamps that will not parse can neither join the sum nor be assumed into it.
 */
export function integrateAwakeSeconds(series: MetricSeries[], gapCapMs: number = GAP_CAP_MS): number {
  let seconds = 0;
  for (const item of series) {
    if (!item || !Array.isArray(item.values)) continue;
    const times: number[] = [];
    for (const sample of item.values) {
      const raw = sample?.timestamp;
      const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
      if (Number.isFinite(parsed)) times.push(parsed);
    }
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i += 1) {
      const gap = times[i] - times[i - 1];
      if (gap > 0 && gap <= gapCapMs) seconds += gap / 1000;
    }
  }
  return seconds;
}

export function utcMonthStart(atMs: number): number {
  const at = new Date(atMs);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

export function utcPeriodKey(atMs: number): string {
  const at = new Date(atMs);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type RenderPlanDeps = {
  monthStartMs: number;
  retentionFloorMs: number;
  birthMs: number;
  periodKey: string;
};

export type RenderPlan = { blocked: string } | { fromMs: number; accumulatedSeconds: number };

/**
 * Pure: decides from where this month's hours can be measured, and how many are
 * already accounted for.
 *
 * Three cases, in order:
 *
 *  1. A checkpoint exists for this month and is newer than the retention floor: the
 *     checkpoint holds every hour from the month's start to its moment, and the API
 *     only has to cover checkpoint → now.
 *  2. No checkpoint, but the month began inside the retention window: the API can
 *     cover the whole month directly.
 *  3. No checkpoint and the month began outside the window: the only honest
 *     complete reading is one where the pre-retention prefix is provably zero -
 *     i.e. the service itself was created after the month began and within
 *     retention. Otherwise the plan blocks with the reason instead of undercounting.
 */
export function planRenderHours(atMs: number, checkpoint: BoardObservation | null, deps: RenderPlanDeps): RenderPlan {
  const { monthStartMs, retentionFloorMs, birthMs, periodKey } = deps;
  if (checkpoint && checkpoint.periodKey === periodKey) {
    const checkpointMs = checkpoint.observedAtUnix * 1000;
    if (checkpointMs < retentionFloorMs) {
      return {
        blocked: `Checkpoint of this month's earlier hours predates Render's 7-day free-plan metrics retention (render.com/docs/service-metrics), so part of the month can no longer be measured - hours withheld rather than undercounted.`,
      };
    }
    return { fromMs: Math.max(checkpointMs, monthStartMs), accumulatedSeconds: checkpoint.used };
  }
  if (monthStartMs < retentionFloorMs) {
    const bornInWindow = birthMs >= monthStartMs && birthMs >= retentionFloorMs;
    if (!bornInWindow) {
      return {
        blocked: `This month began before Render's 7-day free-plan metrics retention (render.com/docs/service-metrics) and no checkpoint of the earlier hours exists - hours withheld rather than undercounted.`,
      };
    }
    return { fromMs: Math.min(Math.max(birthMs, monthStartMs), atMs), accumulatedSeconds: 0 };
  }
  return { fromMs: Math.min(monthStartMs, atMs), accumulatedSeconds: 0 };
}

function isoZ(ms: number): string {
  return new Date(ms).toISOString();
}

export async function measureRenderInstanceHours(at: Date = new Date()): Promise<RenderHoursReading> {
  const key = (process.env.RENDER_API_KEY || "").trim();
  if (!key) {
    return {
      used: null,
      reason: "Render API key not configured (RENDER_API_KEY) - the hours are withheld, never assumed.",
      checkpoint: null,
    };
  }

  const atMs = at.getTime();
  const periodKey = utcPeriodKey(atMs);
  const stored = await readBoardObservation(RENDER_HOURS_KEY);
  const plan = planRenderHours(atMs, stored.observation, {
    monthStartMs: utcMonthStart(atMs),
    retentionFloorMs: atMs - RETENTION_MS,
    birthMs: SERVICE_CREATED_AT_MS,
    periodKey,
  });
  if ("blocked" in plan) return { used: null, reason: plan.blocked, checkpoint: null };

  const url =
    `https://api.render.com/v1/metrics/cpu?startTime=${isoZ(plan.fromMs)}` +
    `&endTime=${isoZ(atMs)}&resource=${SERVICE_ID}&resolutionSeconds=${RESOLUTION_SECONDS}`;
  // bounded() gives this the same 4 s ceiling and null-on-timeout behaviour as every
  // other board source: a hanging Render API costs this row its number, and the board
  // still renders inside the function time limit.
  const body = await bounded(async () => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`render metrics HTTP ${res.status}`);
    return (await res.json()) as MetricSeries[];
  });
  if (!body || !Array.isArray(body)) {
    return {
      used: null,
      reason: "Render metrics API did not answer at read time - the hours are withheld, never assumed.",
      checkpoint: null,
    };
  }

  const seconds = plan.accumulatedSeconds + integrateAwakeSeconds(body);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return {
      used: null,
      reason: "Render metrics API answered with unreadable data - the hours are withheld, never assumed.",
      checkpoint: null,
    };
  }

  return {
    // Two decimals: enough to show a month's drift against a 750-hour ceiling
    // without pretending to a precision the telemetry (300 s scrapes) does not have.
    used: Math.round((seconds / 3600) * 100) / 100,
    reason: null,
    checkpoint: {
      metricKey: RENDER_HOURS_KEY,
      periodKey,
      used: Math.round(seconds),
      observedAtUnix: Math.floor(atMs / 1000),
      detail: "Awake seconds measured from Render CPU telemetry (300 s scrapes) plus stored prefix; free plan retains 7 days of metrics",
    },
  };
}

/**
 * Persists the checkpoint a successful read produced. Called by the board loader;
 * best-effort (see saveBoardObservation), and never on a failed read - a checkpoint
 * is only ever a total we actually measured.
 */
export async function persistRenderCheckpoint(reading: RenderHoursReading): Promise<void> {
  if (reading.checkpoint) await saveBoardObservation(reading.checkpoint);
}
