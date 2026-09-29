import { and, desc, eq } from "drizzle-orm";
import { priceHistory, trackedRoute, type PriceHistoryRow, type TrackedRouteRow } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Durable storage behind tracked routes and price history (TiDB Serverless).
 *
 * Two hard rules shape this module:
 *
 *  1. Storage is optional. Every call degrades to a no-op when DATABASE_URL is
 *     absent (local tooling, the unit suite) or when the database is unreachable,
 *     and every failure is logged rather than thrown. A storage outage may cost us
 *     a history row; it must never cost a customer a search or an alert.
 *
 *  2. Only live observations are ever written. The history table is the asset this
 *     product is eventually paid for, so a seed or estimate price is rejected at
 *     the door rather than merely filtered out on read.
 */

const note = (operation: string, error: unknown) => {
  console.warn(`[price-store] ${operation} skipped:`, error instanceof Error ? error.message : String(error));
};

/** One real observation of a fare. `provider` is mandatory by construction: a row
 *  can never exist without naming the supplier that produced it. */
export type PriceObservation = {
  origin: string;
  destination: string;
  departDate?: string | null;
  price: number;
  currency?: string;
  provider: string;
  purpose?: string;
  routeId?: string | null;
};

/** Everything needed to restore a tracked route from storage. */
export type PersistableRoute = {
  id: string;
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  targetPrice: number;
  currentPrice: number;
  status: "watching" | "alert";
  alertChannel: "Telegram" | "WhatsApp";
  lastCheckedAt?: Date | null;
};

export async function loadPersistedRoutes(): Promise<TrackedRouteRow[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    return await db.select().from(trackedRoute);
  } catch (error) {
    note("loadPersistedRoutes", error);
    return [];
  }
}

export async function persistRoute(route: PersistableRoute): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const values = {
      id: route.id,
      origin: route.origin.toUpperCase(),
      destination: route.destination.toUpperCase(),
      departDate: route.departDate,
      returnDate: route.returnDate || null,
      targetPrice: route.targetPrice,
      currentPrice: route.currentPrice,
      status: route.status,
      alertChannel: route.alertChannel,
      lastCheckedAt: route.lastCheckedAt ?? null,
    };
    await db
      .insert(trackedRoute)
      .values(values)
      .onDuplicateKeyUpdate({
        set: {
          origin: values.origin,
          destination: values.destination,
          departDate: values.departDate,
          returnDate: values.returnDate,
          targetPrice: values.targetPrice,
          currentPrice: values.currentPrice,
          status: values.status,
          alertChannel: values.alertChannel,
          lastCheckedAt: values.lastCheckedAt,
        },
      });
    return true;
  } catch (error) {
    note("persistRoute", error);
    return false;
  }
}

export async function removePersistedRoute(id: string): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    await db.delete(trackedRoute).where(eq(trackedRoute.id, id));
    return true;
  } catch (error) {
    note("removePersistedRoute", error);
    return false;
  }
}

/** Records one fare observation. Refuses anything that is not a positive live price
 *  from a named supplier, so a fabricated number cannot reach the history table. */
export async function recordPricePoint(observation: PriceObservation): Promise<boolean> {
  try {
    if (!Number.isFinite(observation.price) || observation.price <= 0) return false;
    if (!observation.provider) return false;
    const db = await getDb();
    if (!db) return false;
    await db.insert(priceHistory).values({
      origin: observation.origin.toUpperCase(),
      destination: observation.destination.toUpperCase(),
      departDate: observation.departDate || null,
      price: Math.round(observation.price),
      currency: (observation.currency || "USD").toUpperCase(),
      provider: observation.provider,
      source: "live",
      purpose: observation.purpose ?? null,
      routeId: observation.routeId ?? null,
    });
    return true;
  } catch (error) {
    note("recordPricePoint", error);
    return false;
  }
}

/** Most recent live observations for a city pair, newest first. Reads are filtered
 *  to `source = 'live'` as a second guard behind the write-side rejection. */
export async function loadLiveHistory(origin: string, destination: string, limit = 240): Promise<PriceHistoryRow[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    return await db
      .select()
      .from(priceHistory)
      .where(
        and(
          eq(priceHistory.origin, origin.toUpperCase()),
          eq(priceHistory.destination, destination.toUpperCase()),
          eq(priceHistory.source, "live"),
        ),
      )
      .orderBy(desc(priceHistory.capturedAt), desc(priceHistory.id))
      .limit(limit);
  } catch (error) {
    note("loadLiveHistory", error);
    return [];
  }
}
