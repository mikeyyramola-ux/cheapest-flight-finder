import type { Request, Response } from "express";
import { loadCloudBoard, summariseCloudBoard } from "./cloud-quota";
import { QUOTA_WARN_PERCENT } from "./quota";
import { authorizedCron } from "./scheduled";

/**
 * GET /api/ops/quotas - the quota board, read-only.
 *
 * Gated on CRON_SECRET, the same key the scheduled scans already carry, and it fails
 * closed in the same way: with no secret configured the route answers 403 rather than
 * serving an inventory of our infrastructure to anyone who asks. One key, one trust
 * boundary - the cron caller and the operator are the same party here.
 *
 * It only reads. No scan is triggered, no credit is spent, and no notification is
 * generated: opening a dashboard must never be able to consume the alert pool it is
 * supposed to be watching.
 */
export async function opsQuotasHandler(req: Request, res: Response) {
  if (!authorizedCron(req)) {
    return res.status(403).json({ error: "ops-secret-required" });
  }

  try {
    const services = await loadCloudBoard();
    // Never cacheable. A cached body would keep answering with numbers that were
    // true at generation time while the operator reads them as live - the board's
    // own `generatedAt` travels inside the body, but the honest fix is to not hold
    // a snapshot in any layer at all.
    res.set("Cache-Control", "no-store");
    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      warnPercent: QUOTA_WARN_PERCENT,
      summary: summariseCloudBoard(services),
      services,
    });
  } catch {
    // A board that cannot be built says so. It never falls back to a plausible
    // placeholder set of numbers, because a healthy-looking quota page is worse
    // than an error page when the truth is that nothing could be read.
    return res.status(500).json({ error: "quota-board-unavailable" });
  }
}
