import type { Request, Response } from "express";
import { scanTrackedRoutes, sendPriceDropNotification } from "./flight-data";
import { checkPartnerEndpoints } from "./partner-health";
import { sdk } from "./_core/sdk";

/** Cron endpoints are unauthenticated by platform token alone, so they must carry
 *  CRON_SECRET. Fails closed: with no secret configured the route is locked rather
 *  than left open for anyone on the internet to trigger notifications. Vercel Cron
 *  sends `Authorization: Bearer ${CRON_SECRET}` automatically when the env var exists. */
function authorizedCron(req: Request): boolean {
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
    return res.json({
      ok: true,
      checkedAt: result.checkedAt,
      routesChecked: result.alerts.length,
      // Reported honestly: how many routes a supplier actually priced this run. When
      // this is below routesChecked the prices were NOT all refreshed from live data.
      routesLivePriced: result.liveRefreshed,
      suppliersUsed: result.liveProviders,
      notificationsAttempted: notifications.length,
      // Reported honestly - attempted vs actually delivered are not the same number.
      notificationsDelivered: delivered,
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
