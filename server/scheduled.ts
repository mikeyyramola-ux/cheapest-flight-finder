import type { Request, Response } from "express";
import { collectCloudBoardAlerts, CRON_HEARTBEAT_KEY, sendOwnerAlerts, type OwnerAlert } from "./board-escalation";
import { liveBudgetStatus, scanTrackedRoutes, sendPriceDropNotification } from "./flight-data";
import { loadQuotaStatus, QUOTA_WARN_PERCENT } from "./quota";
import { checkPartnerEndpoints } from "./partner-health";
import { saveBoardObservation } from "./observations";
import { sdk } from "./_core/sdk";

/** Cron endpoints are unauthenticated by platform token alone, so they must carry
 *  CRON_SECRET. Fails closed: with no secret configured the route is locked rather
 *  than left open for anyone on the internet to trigger notifications. Vercel Cron
 *  sends `Authorization: Bearer ${CRON_SECRET}` automatically when the env var exists. */
export function authorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const alt = (req.get("x-cron-secret") || "").trim();
  return header === secret || alt === secret;
}

export async function scanFlightDealsHandler(req: Request, res: Response) {
  if (!authorizedCron(req)) {
    return res.status(403).json({ error: "cron-secret-required" });
  }
  try {
    const at = new Date();
    const result = await scanTrackedRoutes();
    const notifications = await Promise.all(result.alerts.filter(item => item.notified).map(item => sendPriceDropNotification(item.route, item.dropPercent)));
    const delivered = notifications.filter(item => item.delivered).length;

    // ESCALATION TRIGGERS (E3/E5/E6 in LEARNING_NOTES). These are emitted as data, not
    // logged and forgotten: an `owner` entry means stop and intervene. A run that
    // quietly refreshes only half its routes, or generates alerts nobody receives,
    // must never be able to look like a healthy run.
    const budget = liveBudgetStatus();
    const quotas = await loadQuotaStatus();
    const escalations: Array<{ level: "owner"; code: "E3" | "E5" | "E6" | "E13" | "E14" | "E16" | "E17" | "E18" | "E19"; detail: string }> = [];
    /** Quota conditions handed to Telegram this run. E14 words are built once, below,
     *  and reused verbatim so the JSON record and the chat cannot disagree. */
    const ownerAlerts: OwnerAlert[] = [];
    if (budget.alert.exhausted) {
      escalations.push({ level: "owner", code: "E3", detail: `alert credit pool exhausted (used ${budget.alert.used}/${budget.alert.limit}); free searches may be starving subscriber alerts` });
    }
    if (result.liveRefreshed < result.routesTotal) {
      escalations.push({ level: "owner", code: "E5", detail: `only ${result.liveRefreshed}/${result.routesTotal} routes priced live; remaining decisions would run on stale prices` });
    }
    if (notifications.length > delivered) {
      escalations.push({ level: "owner", code: "E6", detail: `${notifications.length - delivered} of ${notifications.length} alerts generated but not delivered` });
    }
    // E13: fares were priced live but nothing reached storage. The price-history
    // dataset is the asset this product is built on, so a run that captures live
    // prices and stores none of them has to read as a failure, not a healthy run.
    // Gated on DATABASE_URL so an instance that has no storage configured yet does
    // not cry wolf every night - it reports the missing points as data instead.
    if (process.env.DATABASE_URL && result.liveRefreshed > 0 && result.observationsStored === 0) {
      escalations.push({ level: "owner", code: "E13", detail: `${result.liveRefreshed} routes priced live but 0 history points stored; price history is not accruing` });
    }
    // E14: a supplier's allowance is 75% spent, with a quarter of the pool still
    // left to act on. None of the suppliers expose a usage endpoint, so this ledger
    // is the ONLY warning that exists - and it covers every supplier we track, not
    // just the one currently answering, so a reserve being drained in the background
    // is just as visible as the primary pool running low.
    for (const quota of quotas) {
      if (!quota.warn) continue;
      const state = quota.exhausted ? "EXHAUSTED" : `${quota.percent}% used`;
      const refill = quota.period === "lifetime" ? "one-time allowance - it does not refill" : `resets ${quota.period}`;
      const detail = `${quota.label} quota ${state} (${quota.used}/${quota.limit}, ${refill}); ${quota.source === "database" ? "month-wide count" : "instance view only - storage unreachable"} - top up or cut polling before it hits 100%`;
      escalations.push({
        level: "owner",
        code: "E14",
        detail,
      });
      // Same condition, same words, second channel: the record above and the Telegram
      // bullet are this one string, so they can never drift apart.
      ownerAlerts.push({ code: "E14", key: quota.key, percent: quota.percent, line: detail });
    }

    // E16/E17/E18: the quota board's own warnings, evaluated here because a row nobody
    // opens cannot warn anybody (owner order, 2026-09-30). The collection never throws:
    // a board that cannot be read comes back as a failure string and is escalated as
    // E16, so this check can never look green by being absent (E16's rule).
    const boardAlerts = await collectCloudBoardAlerts(at);
    for (const alert of boardAlerts.alerts) {
      // Both channels, same object: the JSON record and the Telegram bullet are the
      // same `line`, so they cannot drift, and an alert cannot be recorded but unsent.
      escalations.push({ level: "owner", code: alert.code, detail: alert.line });
      ownerAlerts.push(alert);
    }
    if (boardAlerts.failure) {
      const failure: OwnerAlert = {
        code: "E16",
        key: "board-alert-check",
        line: `quota board could not be read for alerting: ${boardAlerts.failure} - E17/E18 were not evaluated this run`,
      };
      ownerAlerts.push(failure);
      escalations.push({ level: "owner", code: "E16", detail: failure.line });
    }

    // One message per code, deduplicated against what was already sent (see
    // board-escalation.ts). Every outcome is returned for the record below - a send
    // Telegram refused must be as visible as one that went out.
    const alertDelivery = await sendOwnerAlerts(ownerAlerts, at);
    console.log(
      `[cron] quota alert check ${boardAlerts.failure ? `FAILED: ${boardAlerts.failure}` : "ok"}; ${
        alertDelivery.length ? alertDelivery.map(item => `${item.code} ${item.action} (${item.entries})`).join(", ") : "no quota condition firing"
      }`,
    );

    // SELF-PROVING CRON (owner GO 2026-09-30): stamp our own TiDB so "did the daily
    // run happen?" stays answerable forever at $0, without Vercel's gated runtime
    // logs. A failed write never turns a healthy run into a 500 - it is reported in
    // this response, and from the next run onward as E19 staleness (absence is never
    // dressed up as all-clear, E15's rule).
    let heartbeat: { ok: boolean; error: string | null; at: string } = { ok: false, error: null, at: at.toISOString() };
    try {
      const stamp = Math.floor(at.getTime() / 1000);
      await saveBoardObservation({
        metricKey: CRON_HEARTBEAT_KEY,
        periodKey: "scan-flight-deals",
        used: stamp,
        observedAtUnix: stamp,
        detail: `[cron] run ok ${at.toISOString()}; heartbeat written by scanFlightDealsHandler`,
      });
      heartbeat = { ok: true, error: null, at: at.toISOString() };
    } catch (error) {
      heartbeat = { ok: false, error: error instanceof Error ? error.message : String(error), at: at.toISOString() };
    }

    return res.json({
      ok: true,
      checkedAt: result.checkedAt,
      routesChecked: result.alerts.length,
      // Reported honestly: how many routes a supplier actually priced this run. When
      // this is below routesChecked the prices were NOT all refreshed from live data.
      routesLivePriced: result.liveRefreshed,
      suppliersUsed: result.liveProviders,
      // Which suppliers answered, by name. `suppliersUsed` is only a count, so it
      // cannot show the monthly-refilling pool being quietly replaced by the one-time
      // pool - which is a capacity change, not a healthy run.
      suppliers: result.suppliers,
      // The asset: durable, supplier-tagged readings this run actually added.
      historyPointsStored: result.observationsStored,
      // Whether the routes priced here were the customer's saved ones or, on a cold
      // start with an empty store, the demo defaults.
      routesRestoredFromStorage: result.hydrated,
      notificationsAttempted: notifications.length,
      // Reported honestly - attempted vs actually delivered are not the same number.
      notificationsDelivered: delivered,
      // Credit position of every tracked supplier. Reported on EVERY run, not only
      // when E14 fires, so the trend is visible long before the threshold is hit.
      quotas: quotas.map(quota => ({
        key: quota.key,
        provider: quota.label,
        used: quota.used,
        limit: quota.limit,
        percent: quota.percent,
        period: quota.period,
        warn: quota.warn,
        exhausted: quota.exhausted,
        wired: quota.wired,
        source: quota.source,
      })),
      quotaWarnPercent: QUOTA_WARN_PERCENT,
      escalations,
      // The quota board's alert pass, reported even when nothing fired: `boardAlertCheck`
      // proves the check ran, so an empty `ownerAlerts` array can never be mistaken for
      // "the check was skipped" - absence is not all-clear (E15's rule, same as the
      // escalations field above).
      boardAlertCheck: { ok: !boardAlerts.failure, error: boardAlerts.failure },
      ownerAlerts: alertDelivery,
      // Proof-of-life for this run, stored under cron:last-run as well (see above).
      heartbeat,
      failures: notifications.filter(item => !item.delivered).map(item => ({ channel: item.channel, reason: item.reason })),
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
  }
}

export async function monitorPartnersHandler(req: Request, res: Response) {
  // Vercel Cron authenticates with CRON_SECRET; the platform heartbeat authenticates
  // with its own signed session. Either is accepted, anything else is refused.
  const secret = process.env.CRON_SECRET;
  const header = (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const cronSecretOk = Boolean(secret) && header === secret;
  if (!cronSecretOk) {
    let user;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      return res.status(403).json({ error: "cron-only" });
    }
    if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
  }
  try {
    const result = await checkPartnerEndpoints();
    return res.json({ ok: true, auth: cronSecretOk ? "cron-secret" : "platform", ...result });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error), context: { url: req.originalUrl }, timestamp: new Date().toISOString() });
  }
}
