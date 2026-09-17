import type { Request, Response } from "express";
import { scanTrackedRoutes, sendPriceDropNotification } from "./flight-data";
import { checkPartnerEndpoints } from "./partner-health";
import { sdk } from "./_core/sdk";

export async function scanFlightDealsHandler(_req: Request, res: Response) {
  try {
    const result = scanTrackedRoutes();
    const notifications = await Promise.all(result.alerts.filter(item => item.notified).map(item => sendPriceDropNotification(item.route, item.dropPercent)));
    return res.json({ ok: true, checkedAt: result.checkedAt, routesChecked: result.alerts.length, notificationsSent: notifications.length });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
  }
}

export async function monitorPartnersHandler(req: Request, res: Response) {
  let user;
  try {
    user = await sdk.authenticateRequest(req);
  } catch {
    return res.status(403).json({ error: "cron-only" });
  }
  if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
  try {
    const result = await checkPartnerEndpoints();
    return res.json({ ok: true, taskUid: user.taskUid, ...result });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error), context: { url: req.originalUrl }, timestamp: new Date().toISOString() });
  }
}
