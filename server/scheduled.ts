import type { Request, Response } from "express";
import { liveBudgetStatus, scanTrackedRoutes, sendPriceDropNotification } from "./flight-data";
import { loadQuotaStatus, QUOTA_WARN_PERCENT } from "./quota";
import { checkPartnerEndpoints } from "./partner-health";
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
    const result = await scanTrackedRoutes();
    const notifications = await Promise.all(result.alerts.filter(item => item.notified).map(item => sendPriceDropNotification(item.route, item.dropPercent)));
    const delivered = notifications.filter(item => item.delivered).length;

    // ESCALATION TRIGGERS (E3/E5/E6 in LEARNING_NOTES). These are emitted as data, not
    // logged and forgotten: an `owner` entry means stop and intervene. A run that
    // quietly refreshes only half its routes, or generates alerts nobody receives,
    // must never be able to look like a healthy run.
    const budget = liveBudgetStatus();
    const quotas = await loadQuotaStatus();
    const escalations: Array<{ level: "owner"; code: "E3" | "E5" | "E6" | "E13" | "E14"; detail: string }> = [];
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
      escalations.push({
        level: "owner",
        code: "E14",
        detail: `${quota.label} quota ${state} (${quota.used}/${quota.limit}, ${refill}); ${quota.source === "database" ? "month-wide count" : "instance view only - storage unreachable"} - top up or cut polling before it hits 100%`,
      });
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
