import { warnAndPage } from "./alerts";
import { and, desc, eq } from "drizzle-orm";
import { priceHistory, trackedRoute, type PriceHistoryRow, type TrackedRouteRow } from "../drizzle/schema";
import { getDb } from "./db";
import { ensureSchema } from "./migrate";

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
  warnAndPage("price-store:skipped", `[price-store] ${operation} skipped:`, error instanceof Error ? error.message : String(error));
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
  /** GO 167 - the customer this route belongs to. Persisted with the row so a
   *  cold start restores each person's list to them, not to everyone. */
  userId?: number | null;
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

/**
 * GO 167 - one customer's routes, and only theirs.
 *
 * Filtering happens in SQL rather than after the fetch, so a subscriber's watch
 * list never travels through memory that also holds other people's. `userId` is a
 * number bound by the driver, so this is not a place for string interpolation.
 */
export async function loadPersistedRoutesForUser(userId: number): Promise<TrackedRouteRow[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    return await db.select().from(trackedRoute).where(eq(trackedRoute.userId, userId));
  } catch (error) {
    note("loadPersistedRoutesForUser", error);
    return [];
  }
}

export async function persistRoute(route: PersistableRoute): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    // GO 167: this write touches `userId`, which the runtime migration adds. Awaiting
    // it here means the first save after a deploy cannot race the ALTER - the memoised
    // promise is already resolved for every later call, so this costs nothing.
    await ensureSchema();
    const values = {
      id: route.id,
      userId: route.userId ?? null,
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
          userId: values.userId,
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

/**
 * GO 167 - deletes a route ONLY if it belongs to the caller.
 *
 * The owner check lives in the WHERE clause, so ownership and deletion are one
 * statement with no window between them. This is the fix for the hole where any
 * subscriber could empty any other subscriber's watch list by guessing an id: an
 * id that is not the caller's simply matches no row, and the caller is told
 * "not found" rather than "forbidden" - because distinguishing those two answers
 * would confirm a stranger's route id exists.
 */
export async function removePersistedRouteForUser(id: string, userId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const result = await db
      .delete(trackedRoute)
      .where(and(eq(trackedRoute.id, id), eq(trackedRoute.userId, userId)));
    // mysql2 reports affected rows; 0 means the row was absent OR not ours, which
    // the caller is deliberately unable to tell apart.
    const affected = (result as unknown as { affectedRows?: number })?.affectedRows;
    return typeof affected === "number" ? affected > 0 : false;
  } catch (error) {
    note("removePersistedRouteForUser", error);
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
