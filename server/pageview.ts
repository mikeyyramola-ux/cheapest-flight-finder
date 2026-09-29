import type { Request, Response } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { pageView } from "../drizzle/schema";
import { authorizedCron } from "./scheduled";
import { bounded } from "./quota";

/**
 * Option B (owner decision 2026-09-29): a first-party page-view beacon.
 *
 * Vercel Web Analytics measures fareloop.in but cannot see getmingle.pages.dev, a
 * Cloudflare Pages property with no analytics installed at all. Instead of handing
 * that traffic to a second third party, the site reports to us: a 1x1 GET pixel
 * increments one row per (site, day, path) in TiDB, and the dashboard reads the
 * aggregate back through `/api/pv/read`.
 *
 * Deliberate constraints:
 *  - GET pixel, never POST: no CORS preflight, no request body, and the platform's
 *    read-only POST gate can never be in the way.
 *  - The write is awaited before the pixel is answered - on serverless a promise
 *    still pending when the response ends can be frozen, which would silently drop
 *    hits while looking successful.
 *  - Every failure path still returns a valid pixel. A page must never learn that
 *    its counting failed, and a lost hit costs nothing; a broken page costs a user.
 *  - Nothing here invents a number: an unrecognised site is not counted at all.
 */

/** 1x1 transparent GIF. */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

const KNOWN_SITES = new Set(["mingle", "fareloop"]);
const MAX_PATH = 255;
const READ_DAYS = 7;

function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

function sendPixel(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.end(PIXEL);
}

/** `GET /api/pv.gif?site=mingle&path=%23%2Fprofile` - count one page view. */
export async function pageViewPixelHandler(req: Request, res: Response): Promise<void> {
  const site = String(req.query.site ?? "").trim().toLowerCase();
  let path = String(req.query.path ?? "/").trim() || "/";
  if (!path.startsWith("/")) path = "/" + path;
  path = path.slice(0, MAX_PATH);

  if (!KNOWN_SITES.has(site)) {
    // Not a property we measure: answer the pixel, count nothing. Guessing which
    // site was meant would put a number on the wrong ledger.
    sendPixel(res);
    return;
  }

  try {
    const db = await getDb();
    if (db) {
      const day = utcDay();
      await bounded(() =>
        db
          .insert(pageView)
          .values({ site, day, path, hits: 1 })
          .onDuplicateKeyUpdate({
            set: { hits: sql`${pageView.hits} + 1` },
          }),
      );
    }
  } catch {
    // Counting is bookkeeping: a failed write must never surface to the visitor
    // whose page is reporting, and must never take the request down with it.
  }
  sendPixel(res);
}

/** `GET /api/pv/read?site=mingle` - the 7-day aggregate the dashboard charts.
 *  Owner-only: carries the same CRON_SECRET the scheduled routes use, so the
 *  counts are never exposed publicly. */
export async function pageViewReadHandler(req: Request, res: Response): Promise<void> {
  if (!authorizedCron(req)) {
    res.status(403).json({ real: false, error: "cron-secret-required" });
    return;
  }
  const site = String(req.query.site ?? "mingle").trim().toLowerCase();
  if (!KNOWN_SITES.has(site)) {
    res.status(400).json({ real: false, reason: "unknown site" });
    return;
  }

  try {
    const db = await getDb();
    if (!db) {
      res.json({ real: false, reason: "database unavailable" });
      return;
    }
    const since = utcDay(new Date(Date.now() - (READ_DAYS - 1) * 86_400_000));
    const rows = await db
      .select({
        day: pageView.day,
        hits: sql<number>`sum(${pageView.hits})`,
      })
      .from(pageView)
      .where(and(eq(pageView.site, site), gte(pageView.day, since)))
      .groupBy(pageView.day);

    const byDay = new Map<string, number>();
    for (const row of rows) {
      if (row.day) byDay.set(row.day, Number(row.hits) || 0);
    }

    // One bucket per day of the window, oldest first. A day with no row is a day
    // we served no counted hits - a measured zero, not a gap to paper over.
    const series: Array<{ d: string; pv: number }> = [];
    for (let back = READ_DAYS - 1; back >= 0; back--) {
      const day = utcDay(new Date(Date.now() - back * 86_400_000));
      series.push({ d: day.slice(5), pv: byDay.get(day) ?? 0 });
    }

    res.json({
      real: true,
      source: "first-party-pixel",
      site,
      days: READ_DAYS,
      series,
      total_pv: series.reduce((sum, item) => sum + item.pv, 0),
      rows: rows.length,
      fetched_at: utcDay() + " " + new Date().toISOString().slice(11, 16) + " UTC",
    });
  } catch {
    res.json({ real: false, reason: "query failed" });
  }
}
