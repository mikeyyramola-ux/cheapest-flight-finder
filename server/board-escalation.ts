import { CLOUD_SERVICE_DEFS, loadCloudBoard, type CloudPeriod, type CloudServiceRow } from "./cloud-quota";
import { formatObservationUtc, readBoardObservation, saveBoardObservation } from "./observations";
import { deliverTelegram } from "./telegram";

/**
 * The quota board's warnings, said out loud (owner order, 2026-09-30: "for telegram
 * yes wire that").
 *
 * The board already knew a ceiling was 75% spent - it just had no way to say so to
 * anyone who was not looking at it. E14 proved the shape of the gap: a warning that
 * only exists as a row nobody reads is a warning that does not exist. This module
 * gives every quota the board watches a voice, in four codes that are all lesson
 * numbers from LEARNING_NOTES:
 *
 *  - E14  a supplier credit pool at or over 75%. Built by the caller (scheduled.ts)
 *         from the same quota ledger that feeds the JSON record, so the chat bullet
 *         and the escalation detail are the same words. Supplier rows on the board
 *         are deliberately NOT re-reported here: one condition, one code.
 *  - E17  any other board row at or over 75% - Render hours, Fast Data Transfer,
 *         TiDB RU, storage, deployments, engine freshness.
 *  - E18  an audit-fed row (tidb-ru, vercel-data-transfer) whose console reading is
 *         older than 24 h or missing. The audit slipping has to be an alert in its
 *         own right; otherwise the first sign of a missed audit is a board row that
 *         quietly goes stale (and is withheld only when someone finally looks).
 *  - E16  the check itself could not run (the board could not be read). Reported as
 *         failure, never as silence - E16's own rule: the wire must fail into
 *         failure, never into green.
 *  - E19  the cron's own heartbeat (cron:last-run) went stale: at least one daily
 *         12:00 UTC run was missed. The heartbeat is stamped by every successful
 *         run, and the NEXT run is what can notice a gap - this code is how a missed
 *         run gets reported instead of silently missing twice.
 *
 * Three rules this file exists to keep:
 *
 *  1. Never duplicate. The cron runs once a day, so an unchanged condition would
 *     otherwise say the same thing forever. Per code, the last send is stored in
 *     `board_observations` under an `alert:` key - a fingerprint of exactly what
 *     fired, plus the moment it was sent. An identical condition is suppressed until
 *     it changes, until it clears and returns, or until 7 days have passed (a
 *     standing problem still re-announces itself weekly, but a chat is never spammed
 *     daily by one quiet number). Quota fingerprints bucket percent in 5s, so a pool
 *     climbing 75 -> 79 reports once and the next message comes at 80.
 *  2. Never miss. Dedup state that cannot be read fails OPEN (send rather than
 *     swallow), and a message Telegram refused is never recorded as sent, so the next
 *     run tries again. When an emergency finally comes, "no missed alerts" outranks
 *     "no duplicate alerts".
 *  3. Never invent. Every line is built from a board row's own numbers (used, limit,
 *     percent, feed) or from a stored observation with its recorded timestamp. No
 *     value is estimated, rounded into existence, or carried over from a previous
 *     run - the same standard the board itself is held to.
 *
 * Delivery is `deliverTelegram`, the same sender a price drop uses, so "delivered"
 * means exactly the same thing for both.
 */

/** A console reading older than this is an E18: past one full day a daily audit has
 *  demonstrably not happened today, with 6 hours of warning left before the board's
 *  own 30-hour withholding rule kicks in. */
export const AUDIT_OVERDUE_MS = 24 * 60 * 60 * 1000;

/** How long an unchanged condition may stand before it re-announces itself. */
export const ALERT_REMIND_MS = 7 * 24 * 60 * 60 * 1000;

/** Dedup rows live in board_observations under this prefix, so they can never be
 *  mistaken for a quota metric (the board only ever reads its own metric keys). */
export const QUOTA_ALERT_STATE_PREFIX = "alert:";

/** Every successful cron run stamps this row into board_observations (scheduled.ts
 *  writes it at the end of the run). It is the cron's own proof of life: a row older
 *  than CRON_HEARTBEAT_STALE_MS is a missed run, reported as E19 by the next run.
 *  Not a quota metric - the board only ever reads its own metric keys. */
export const CRON_HEARTBEAT_KEY = "cron:last-run";

/** A heartbeat past this age means at least one 12:00 UTC run did not happen. The
 *  schedule is daily with Vercel's flexible 1-hour window, so 25 h clears the window
 *  plus a full day of margin before a miss is declared. */
export const CRON_HEARTBEAT_STALE_MS = 25 * 60 * 60 * 1000;

/** Stored detail for a condition that is no longer firing - the marker that lets a
 *  recurrence be treated as news instead of as an unchanged repeat. */
export const ALERT_CLEAR_MARK = "clear";

export const OWNER_ALERT_CODES = ["E14", "E16", "E17", "E18", "E19"] as const;
export type OwnerAlertCode = (typeof OWNER_ALERT_CODES)[number];

export type OwnerAlert = {
  code: OwnerAlertCode;
  /** Stable identity of the condition: a board row key, an audit metric key, or the
   *  check itself. Part of the dedup fingerprint. */
  key: string;
  /** Present for quota conditions (E14/E17); dedup is per 5% band. */
  percent?: number;
  /** One self-contained line: the cron puts it in `escalations[]`, Telegram gets it
   *  as a bullet. Same words in both places, so they cannot disagree. */
  line: string;
};

/** What happened when an alert's code was handed to Telegram. Always reported, so an
 *  empty result can never be mistaken for "nothing was checked". */
export type OwnerAlertDelivery = {
  code: OwnerAlertCode;
  /** How many conditions fired under this code in this run. */
  entries: number;
  action: "sent" | "suppressed" | "failed";
  delivered: boolean;
  reason: string;
};

/** Exactly what fired, in a form that can be compared across runs. Percent is bucketed
 *  to 5s: 75-79% is one message, 80% is the next, and a number that has not moved at
 *  all is recognisably unchanged. */
function fingerprintOf(alerts: OwnerAlert[]): string {
  return alerts
    .map(alert => (alert.percent !== undefined ? `${alert.key}@${Math.floor(alert.percent / 5)}` : alert.key))
    .sort()
    .join("|");
}

function periodPhrase(period: CloudPeriod): string {
  switch (period) {
    case "month":
      return "resets monthly";
    case "day":
      return "rolling 24 h window";
    case "lifetime":
      return "one-time allowance - it does not refill";
    case "standing":
      return "standing ceiling";
    default:
      return "no reset";
  }
}

/** One board row as a sentence, from its own figures only. `percent` may exceed 100
 *  (a standing ceiling crossed) and says so rather than clipping itself. */
function quotaLine(row: CloudServiceRow): string {
  const unit = row.unit ? ` ${row.unit}` : "";
  const ceiling = row.exhausted ? "CEILING CROSSED" : "at or over the 75% line";
  return `${row.service} / ${row.metric}: ${row.percent}% used (${row.used} of ${row.limit}${unit}, ${periodPhrase(row.period)}) - ${ceiling}, ${row.feed} reading; act before 100%`;
}

/** An audit-fed row whose stored console reading may no longer be presented as current.
 *  null = fresh, nothing to say. */
async function auditOverdueLine(key: string, service: string, metric: string, at: Date): Promise<string | null> {
  const read = await readBoardObservation(key);
  if (!read.observation) {
    return `${service} / ${metric}: daily audit overdue - no console reading found (${read.reason}); the board shows no number for this row until one is recorded`;
  }
  const observedAtUnix = read.observation.observedAtUnix;
  const ageMs = at.getTime() - observedAtUnix * 1000;
  if (ageMs >= 0 && ageMs <= AUDIT_OVERDUE_MS) return null;
  if (ageMs < 0) {
    // A reading from the future is not a current reading - a clock or a bad write,
    // either way it cannot be trusted to mean "checked today".
    return `${service} / ${metric}: daily audit overdue - stored reading is timestamped ${formatObservationUtc(observedAtUnix)}, ahead of now (${at.toISOString().slice(0, 16).replace("T", " ")} UTC); a future timestamp is not a fresh reading`;
  }
  return `${service} / ${metric}: daily audit overdue - last console reading ${(ageMs / 3_600_000).toFixed(1)} h old (recorded ${formatObservationUtc(observedAtUnix)}), past the 24 h line; the board withholds it past 30 h`;
}

export type CloudBoardAlertScan = {
  alerts: OwnerAlert[];
  /** null when the check ran. A board that could not be read comes back here and is
   *  reported as E16 - never dropped, never turned into "all clear". */
  failure: string | null;
};

/**
 * Evaluates the quota board for E17 (row at or over 75%) and E18 (audit overdue).
 *
 * Never throws: the board loader's own failure contract plus a catch-all here mean a
 * broken board is a *reported* failure, so the cron's price-scan work cannot be taken
 * down with it and a silent skip is impossible.
 */
export async function collectCloudBoardAlerts(at: Date): Promise<CloudBoardAlertScan> {
  try {
    const rows = await loadCloudBoard(at);
    const alerts: OwnerAlert[] = [];

    for (const row of rows) {
      // Supplier pools belong to E14 (the caller feeds them from the same ledger that
      // produces the E14 record). Reporting them here too would put one condition
      // under two codes - the duplicate reporting this file exists to avoid.
      if (row.category === "supplier") continue;
      if (!row.warn || row.percent === null || row.used === null || row.limit === null) continue;
      alerts.push({ code: "E17", key: row.key, percent: row.percent, line: quotaLine(row) });
    }

    for (const def of CLOUD_SERVICE_DEFS) {
      if (def.feed !== "audit") continue;
      const line = await auditOverdueLine(def.key, def.service, def.metric, at);
      if (line) alerts.push({ code: "E18", key: def.key, line });
    }

    // E19: the cron's own heartbeat (scheduled.ts stamps it at the end of every
    // successful run). A row older than 25 h means at least one 12:00 UTC run was
    // missed - this run reports it, because a missed run cannot report itself. No
    // row yet = first deploy of the heartbeat: nothing to compare, no wolf cried.
    const beat = await readBoardObservation(CRON_HEARTBEAT_KEY);
    if (beat.observation) {
      const ageMs = at.getTime() - beat.observation.observedAtUnix * 1000;
      if (ageMs > CRON_HEARTBEAT_STALE_MS) {
        alerts.push({
          code: "E19",
          key: "cron-heartbeat",
          line: `daily cron heartbeat is ${(ageMs / 3_600_000).toFixed(1)} h old (last ok run ${formatObservationUtc(beat.observation.observedAtUnix)}); at least one 12:00 UTC run was missed - this run is reporting it`,
        });
      }
    }

    return { alerts, failure: null };
  } catch (error) {
    return { alerts: [], failure: error instanceof Error ? error.message : String(error) };
  }
}

const ALERT_COPY: Record<OwnerAlertCode, { title: string; footer: string }> = {
  E14: {
    title: "PRIME supplier quota [E14] - credit pools at or over 75%:",
    footer: "Top up or cut polling before 100%: a dry pool is a subscriber alert that never goes out.",
  },
  E17: {
    title: "PRIME quota board [E17] - cloud quota rows at or over 75%:",
    footer: "Act before 100%: each ceiling here suspends the free tier it belongs to.",
  },
  E18: {
    title: "PRIME daily audit overdue [E18] - console readings past the 24 h line:",
    footer: "Run today's audit (TiDB console 'Capacity used this month', Vercel Usage page). Past 30 h the board withholds the number instead of showing it stale.",
  },
  E16: {
    title: "PRIME board alert check failed [E16] - quota alerts could not be evaluated:",
    footer: "The quota board may be unreadable too; treat E14/E17/E18 as unchecked for this run.",
  },
  E19: {
    title: "PRIME cron heartbeat stale [E19] - a daily run was missed:",
    footer: "Every successful run stamps cron:last-run; a stale stamp means the 12:00 UTC schedule has a gap. Prove it truly never ran before re-running anything - no duplicate runs (E15 rule 1).",
  },
};

function renderAlertMessage(code: OwnerAlertCode, entries: OwnerAlert[]): string {
  const copy = ALERT_COPY[code];
  return [
    copy.title,
    ...entries.map(entry => `- ${entry.line}`),
    copy.footer,
    "- Prime Dashboard-5000, daily cron 12:00 UTC",
  ].join("\n");
}

/**
 * Sends the firing alerts, one message per code, deduplicated against what was sent
 * before - and reports exactly what happened for the cron record.
 *
 * Suppression is decided before any network call, so an unchanged condition costs one
 * SELECT per run and no chat noise. A send is only recorded when Telegram accepted it;
 * an undelivered message leaves the stored state untouched so the next run retries.
 * When nothing fires under a code that has a stored state, that state is marked
 * "clear" (only if a row already exists) so a returning condition is news again.
 */
export async function sendOwnerAlerts(alerts: OwnerAlert[], at: Date): Promise<OwnerAlertDelivery[]> {
  const nowUnix = Math.floor(at.getTime() / 1000);
  const results: OwnerAlertDelivery[] = [];

  for (const code of OWNER_ALERT_CODES) {
    const entries = alerts.filter(alert => alert.code === code);
    const stateKey = `${QUOTA_ALERT_STATE_PREFIX}${code}`;
    try {
      if (entries.length === 0) {
        const state = await readBoardObservation(stateKey);
        if (state.observation && state.observation.detail !== ALERT_CLEAR_MARK) {
          await saveBoardObservation({
            metricKey: stateKey,
            periodKey: code,
            used: nowUnix,
            observedAtUnix: nowUnix,
            detail: ALERT_CLEAR_MARK,
          });
        }
        continue;
      }

      const fingerprint = fingerprintOf(entries);
      const state = await readBoardObservation(stateKey);
      if (state.observation) {
        const stored = state.observation;
        const ageMs = at.getTime() - stored.observedAtUnix * 1000;
        const unchanged = stored.detail === fingerprint;
        // Suppress only the boring case: same conditions, already reported, recently,
        // with a timestamp that makes sense. Everything else (changed, cleared and
        // returned, unreadable store, 7 days elapsed, clock oddity) sends.
        if (unchanged && ageMs >= 0 && ageMs < ALERT_REMIND_MS) {
          results.push({
            code,
            entries: entries.length,
            action: "suppressed",
            delivered: false,
            reason: `identical condition already reported ${Math.round(ageMs / 3_600_000)} h ago - suppressed instead of repeated`,
          });
          continue;
        }
      }

      const sent = await deliverTelegram(renderAlertMessage(code, entries));
      if (sent.delivered) {
        let stateNote = "";
        try {
          await saveBoardObservation({
            metricKey: stateKey,
            periodKey: code,
            // `used` carries the send moment (the schema demands a number and a 0 would
            // read as a measured zero); it duplicates observed_at_unix and is never a
            // quota value - alert: rows are read by this file only.
            used: nowUnix,
            observedAtUnix: nowUnix,
            detail: fingerprint,
          });
        } catch (error) {
          // The message WAS accepted - that stays true even if its dedup record could
          // not be written. Reported as a delivered send with the gap named, because
          // downgrading an accepted message to "failed" would be its own lie (and the
          // worst case of the missing record is one repeat later, not a missed alert).
          stateNote = ` (dedup state not recorded: ${error instanceof Error ? error.message : String(error)} - the next run may repeat this)`;
        }
        results.push({ code, entries: entries.length, action: "sent", delivered: true, reason: `${sent.reason}${stateNote}` });
      } else {
        results.push({
          code,
          entries: entries.length,
          action: "failed",
          delivered: false,
          reason: `${sent.reason} - nothing recorded, so the next run tries again`,
        });
      }
    } catch (error) {
      // A dispatcher bug must not take the cron's response down with it, and it must
      // not be reported as a send: failed, with the reason, so the next run retries.
      results.push({
        code,
        entries: entries.length,
        action: "failed",
        delivered: false,
        reason: `alert dispatcher failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return results;
}
