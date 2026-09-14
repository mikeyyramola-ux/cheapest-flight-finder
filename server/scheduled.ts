import type { Request, Response } from "express";
import { scanTrackedRoutes, sendPriceDropNotification } from "./flight-data";

export async function scanFlightDealsHandler(_req: Request, res: Response) {
  try {
    const result = scanTrackedRoutes();
    const notifications = await Promise.all(result.alerts.filter(item => item.notified).map(item => sendPriceDropNotification(item.route, item.dropPercent)));
    return res.json({ ok: true, checkedAt: result.checkedAt, routesChecked: result.alerts.length, notificationsSent: notifications.length });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error), timestamp: new Date().toISOString() });
  }
}
