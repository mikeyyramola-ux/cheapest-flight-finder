/**
 * Live probe of the cloud engine that runs on Render (prime-enterprise.onrender.com).
 *
 * Why the quota board reads it: Render hosts the PRIMARY engine - the local one is
 * standby (ENGINE_ROLE=standby, owner-approved wire v1) - yet until 2026-09-30 it
 * appeared nowhere on the board. An operator had no frame that could answer "is the
 * engine that runs everything even answering, and is its ledger current?".
 *
 * What it measures, and why not something simpler: Render's /api/health answers
 * {ok:true} even when the radar/pilot threads are dead - that is precisely the
 * 09-24/25 overnight failure (Flask serving 200s, engine dark). The ledger
 * timestamp `updated` in /api/state is written by STORE.save on every real event,
 * so its AGE is the honest freshness of the engine itself. Flask up + stale
 * timestamp = daemons down, and this probe is the thing that can see it.
 *
 * Rules this file exists to keep (same rules as cloud-quota.ts):
 *  - never throws: every failure path returns {used: null, reason} so the caller
 *    reports an unread value, never a plausible one;
 *  - bounded: a spun-down free instance takes ~60 s to wake, so the probe gives up
 *    at PROBE_TIMEOUT_MS rather than holding the ops board open behind it;
 *  - zero cost: one GET of a page the mirror already reads, no key, no charge.
 */

export type RenderProbeResult = {
  /** Minutes since the engine last wrote its ledger, floored; null = no reading. */
  used: number | null;
  /** Why there is no number, when there is none. Null when a reading was taken. */
  reason: string | null;
};

const DEFAULT_STATE_URL = "https://prime-enterprise.onrender.com/api/state";
const DEFAULT_TIMEOUT_MS = 6_000;

function stateUrl(): string {
  const fromEnv = (process.env.RENDER_STATE_URL || "").trim();
  return fromEnv || DEFAULT_STATE_URL;
}

function probeTimeoutMs(): number {
  const fromEnv = Number(process.env.RENDER_PROBE_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

function stamp(at: Date): string {
  return at.toISOString().slice(11, 16);
}

/**
 * Reads the engine's own `updated` ledger stamp and returns its age in whole
 * minutes. The stamp is UTC written as "YYYY-MM-DD HH:MM:SS" (utc() in app.py);
 * it is parsed as UTC explicitly so a runtime that assumes local time cannot
 * turn freshness into a multi-hour error.
 */
export async function probeRenderEngine(at: Date = new Date()): Promise<RenderProbeResult> {
  const fail = (reason: string): RenderProbeResult => ({
    used: null,
    reason: `probe failed ${stamp(at)} UTC (${reason}) - engine number withheld, never assumed`,
  });

  try {
    const timeoutMs = probeTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(stateUrl(), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return fail(`HTTP ${response.status}`);
    let body: { updated?: unknown };
    try {
      body = (await response.json()) as { updated?: unknown };
    } catch {
      return fail("unparseable answer");
    }
    const updated = typeof body?.updated === "string" ? body.updated : "";
    const parsed = new Date(`${updated.slice(0, 19).replace(" ", "T")}Z`);
    if (Number.isNaN(parsed.getTime())) return fail("no ledger timestamp in the answer");
    const ageMin = Math.floor((at.getTime() - parsed.getTime()) / 60_000);
    // Negative age = clock skew between here and Render; a clock we cannot trust
    // reports as "just written" rather than as "written in the future".
    return { used: Math.max(0, ageMin), reason: null };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return fail(`timeout after ${probeTimeoutMs()} ms`);
    }
    // A plain Error's name is just "Error", which explains nothing - the message
    // carries what actually went wrong ("connection refused", "DNS failure").
    const detail = error instanceof Error ? (error.name === "Error" ? error.message : error.name) : "fetch-failed";
    return fail(detail);
  }
}
