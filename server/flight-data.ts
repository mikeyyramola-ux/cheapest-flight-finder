import { loadLiveHistory, loadPersistedRoutes, persistRoute, recordPricePoint, removePersistedRoute, type PersistableRoute } from "./price-store";
import { chargeQuota } from "./quota";
import type { PriceHistoryRow, TrackedRouteRow } from "../drizzle/schema";

export type Cabin = "Economy" | "Premium economy" | "Business";

export type FlightOffer = {
  id: string;
  airline: string;
  airlineCode: string;
  origin: string;
  destination: string;
  departureDate: string;
  departureTime: string;
  arrivalTime: string;
  duration: string;
  stops: number;
  price: number;
  currency: string;
  cabin: Cabin;
  baggage: string;
  bookingUrl: string;
  isBest: boolean;
  returnPrice?: number;
  layoverCountry?: string;
  source: "Seed data" | "Estimate" | "Live fare";
  /** Which supplier produced this fare. Only set for "Live fare". Kept so that if we
   *  ever rotate between suppliers, no chart or history can silently blend two of them. */
  provider?: string;
};

export type TrackedRoute = {
  id: string;
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  targetPrice: number;
  currentPrice: number;
  historicalAverage: number;
  lastChecked: string;
  status: "watching" | "alert";
  alertChannel: "Telegram" | "WhatsApp";
};

export type PriceHistoryPoint = { date: string; price: number };

const now = new Date();
const isoDate = (offset: number) => {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

const seedOffers: FlightOffer[] = [
  { id: "offer-nyc-lon-1", airline: "Virgin Atlantic", airlineCode: "VS", origin: "JFK", destination: "LHR", departureDate: isoDate(45), departureTime: "19:30", arrivalTime: "07:25", duration: "6h 55m", stops: 0, price: 418, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: "https://www.virginatlantic.com/", isBest: true, source: "Seed data" },
  { id: "offer-nyc-lon-2", airline: "British Airways", airlineCode: "BA", origin: "JFK", destination: "LHR", departureDate: isoDate(45), departureTime: "21:10", arrivalTime: "09:00", duration: "6h 50m", stops: 0, price: 447, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: "https://www.britishairways.com/", isBest: false, source: "Seed data" },
  { id: "offer-nyc-lon-3", airline: "Iberia", airlineCode: "IB", origin: "JFK", destination: "LHR", departureDate: isoDate(45), departureTime: "18:05", arrivalTime: "10:15", duration: "10h 10m", stops: 1, price: 389, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: "https://www.iberia.com/", isBest: false, source: "Seed data" },
  { id: "offer-nyc-lon-4", airline: "Delta", airlineCode: "DL", origin: "JFK", destination: "LHR", departureDate: isoDate(45), departureTime: "22:45", arrivalTime: "10:40", duration: "6h 55m", stops: 0, price: 512, currency: "USD", cabin: "Premium economy", baggage: "1 checked bag", bookingUrl: "https://www.delta.com/", isBest: false, source: "Seed data" },
  { id: "offer-lon-tok-1", airline: "Finnair", airlineCode: "AY", origin: "LHR", destination: "HND", departureDate: isoDate(60), departureTime: "10:20", arrivalTime: "08:15", duration: "13h 55m", stops: 1, price: 806, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: "https://www.finnair.com/", isBest: true, source: "Seed data" },
  { id: "offer-dxb-nyc-1", airline: "Emirates", airlineCode: "EK", origin: "DXB", destination: "JFK", departureDate: isoDate(52), departureTime: "08:45", arrivalTime: "14:25", duration: "14h 40m", stops: 0, price: 928, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: "https://www.emirates.com/", isBest: true, source: "Seed data" },
];

const seedHistory: Record<string, PriceHistoryPoint[]> = {
  "JFK-LHR": [
    { date: "Apr 10", price: 672 }, { date: "Apr 17", price: 610 }, { date: "Apr 24", price: 588 }, { date: "May 01", price: 562 }, { date: "May 08", price: 534 }, { date: "May 15", price: 498 }, { date: "May 22", price: 476 }, { date: "May 29", price: 452 }, { date: "Jun 05", price: 438 }, { date: "Jun 12", price: 418 },
  ],
  "LHR-HND": [
    { date: "Apr 10", price: 1020 }, { date: "Apr 17", price: 985 }, { date: "Apr 24", price: 940 }, { date: "May 01", price: 912 }, { date: "May 08", price: 880 }, { date: "May 15", price: 846 }, { date: "May 22", price: 820 }, { date: "May 29", price: 816 }, { date: "Jun 05", price: 806 },
  ],
  "DXB-JFK": [
    { date: "Apr 10", price: 1184 }, { date: "Apr 17", price: 1120 }, { date: "Apr 24", price: 1092 }, { date: "May 01", price: 1040 }, { date: "May 08", price: 1015 }, { date: "May 15", price: 978 }, { date: "May 22", price: 954 }, { date: "May 29", price: 928 },
  ],
};

const cachedResults = new Map<string, { expiresAt: number; offers: FlightOffer[]; source: "seed" | "estimate" | "live" }>();
const DEFAULT_ROUTES: TrackedRoute[] = [
  { id: "route-1", origin: "JFK", destination: "LHR", departDate: isoDate(45), returnDate: isoDate(52), targetPrice: 450, currentPrice: 418, historicalAverage: 532, lastChecked: "12 min ago", status: "alert", alertChannel: "Telegram" },
  { id: "route-2", origin: "LHR", destination: "HND", departDate: isoDate(60), returnDate: isoDate(74), targetPrice: 760, currentPrice: 806, historicalAverage: 899, lastChecked: "12 min ago", status: "watching", alertChannel: "WhatsApp" },
];

const trackedRoutes = new Map(DEFAULT_ROUTES.map(route => [route.id, route]));

export function routeKey(origin: string, destination: string) {
  return `${origin.toUpperCase()}-${destination.toUpperCase()}`;
}

/* ---------------------------------------------------------------------------------
 * Storage-backed state.
 *
 * The Map below is a cache, not the source of truth. It used to be the source of
 * truth, which meant every serverless cold start discarded whatever a customer had
 * saved and put the demo routes back on their dashboard.
 * --------------------------------------------------------------------------------- */

/** Live price series read from storage, keyed by "ORIG-DEST". The key only exists
 *  once a load has been attempted, so "no history yet" stays distinguishable from
 *  "not loaded yet" - the latter must never be read as the former. */
const liveHistoryCache = new Map<string, PriceHistoryPoint[]>();
const inFlightHistoryLoads = new Map<string, Promise<void>>();
let routesHydration: Promise<boolean> | null = null;

/** When each route was genuinely priced, kept beside the cache so a scan that cannot
 *  re-price a route does not overwrite its real timestamp with a guess. */
const lastCheckedAtById = new Map<string, Date>();

/** Local calendar day of an observation, so day boundaries match when it was seen. */
function dayLabel(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/**
 * Turns stored rows into the series a chart should draw.
 *
 * Every observation carries the travel date it priced, and tracked routes slide
 * their travel date forward day by day, so plotting them all together would draw
 * two different journeys as one trend. We keep only the rows sharing the travel
 * date of the most recent observation - one coherent journey through time - and
 * collapse same-day duplicates to the lowest price seen, which is what a price
 * chart is understood to mean.
 */
function toSeries(rows: PriceHistoryRow[]): PriceHistoryPoint[] {
  if (rows.length === 0) return [];
  const latest = rows[0].departDate;
  const coherent = latest ? rows.filter(row => row.departDate === latest) : rows;
  const lowestPerDay = new Map<string, number>();
  for (const row of coherent) {
    const day = dayLabel(row.capturedAt);
    const previous = lowestPerDay.get(day);
    if (previous === undefined || row.price < previous) lowestPerDay.set(day, row.price);
  }
  return Array.from(lowestPerDay, ([date, price]) => ({ date, price })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Span actually covered by the series, taken from the data rather than a claim. */
function windowSpanDays(points: PriceHistoryPoint[]): number {
  if (points.length < 2) return 0;
  const first = Date.parse(`${points[0].date}T00:00:00Z`);
  const last = Date.parse(`${points[points.length - 1].date}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(last)) return 0;
  return Math.max(0, Math.round((last - first) / 86_400_000));
}

function sinceLabel(at: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function rowToRoute(row: TrackedRouteRow): TrackedRoute {
  return {
    id: row.id,
    origin: row.origin,
    destination: row.destination,
    departDate: row.departDate,
    returnDate: row.returnDate ?? "",
    targetPrice: row.targetPrice,
    currentPrice: row.currentPrice,
    // Deliberately recomputed rather than stored: an average belongs to the series
    // that produced it, so it must move the moment new live observations land.
    historicalAverage: getHistoricalAverage(row.origin, row.destination),
    lastChecked: row.lastCheckedAt ? sinceLabel(row.lastCheckedAt) : "not checked yet",
    status: row.status,
    alertChannel: row.alertChannel,
  };
}

function toPersistable(route: TrackedRoute, lastCheckedAt: Date | null): PersistableRoute {
  return {
    id: route.id,
    origin: route.origin,
    destination: route.destination,
    departDate: route.departDate,
    returnDate: route.returnDate,
    targetPrice: route.targetPrice,
    currentPrice: route.currentPrice,
    status: route.status,
    alertChannel: route.alertChannel,
    lastCheckedAt,
  };
}

/**
 * Restores tracked routes from storage, at most once per container. An empty store
 * is not a failure - a brand-new instance starts on the demo routes and adopts
 * storage the first time a route is saved.
 */
export function ensureRoutesHydrated(): Promise<boolean> {
  if (!routesHydration) {
    routesHydration = loadPersistedRoutes()
      .then(async rows => {
        if (rows.length > 0) {
          // The live series is loaded BEFORE the routes are materialised. Building a
          // route first would stamp it with the seed average, and a customer would see
          // a restored route quoting a number no supplier ever gave.
          await Promise.all(rows.map(row => ensureHistoryLoaded(row.origin, row.destination)));
          trackedRoutes.clear();
          for (const row of rows) {
            trackedRoutes.set(row.id, rowToRoute(row));
            if (row.lastCheckedAt) lastCheckedAtById.set(row.id, row.lastCheckedAt);
          }
        }
        return rows.length > 0;
      })
      .catch(error => {
        console.warn("[flight-data] route hydration failed:", error instanceof Error ? error.message : error);
        // Clear rather than memoise the failure, so a later call can retry.
        routesHydration = null;
        return false;
      });
  }
  return routesHydration;
}

/**
 * Loads the live series for a city pair into the cache. Routers await this before
 * reading `getRouteHistory`, which stays synchronous for the rest of the codebase.
 */
export function ensureHistoryLoaded(origin: string, destination: string): Promise<void> {
  const key = routeKey(origin, destination);
  if (liveHistoryCache.has(key)) return Promise.resolve();
  const pending = inFlightHistoryLoads.get(key);
  if (pending) return pending;

  const load = loadLiveHistory(origin, destination)
    .then(rows => {
      liveHistoryCache.set(key, toSeries(rows));
    })
    .catch(error => {
      console.warn("[flight-data] history load failed:", error instanceof Error ? error.message : error);
      // Left uncached on purpose: the next reader retries instead of inheriting a
      // permanent "no history" answer from one bad request.
    })
    .finally(() => {
      inFlightHistoryLoads.delete(key);
    });
  inFlightHistoryLoads.set(key, load);
  return load;
}

/** Drops a cached series so the next read picks up freshly recorded observations. */
function invalidateHistory(origin: string, destination: string) {
  liveHistoryCache.delete(routeKey(origin, destination));
}


/** Provenance of a price series. The client MUST label charts from this value -
 *  never hardcode "Live" in the UI, or sample data gets sold as live airline quotes. */
export type HistorySource = "seed" | "estimate" | "live";

export interface RouteHistory {
  points: PriceHistoryPoint[];
  source: HistorySource;
  /** Actual number of days the series spans, derived from the data - not a marketing figure. */
  windowDays: number;
}

export function getRouteHistory(origin: string, destination: string): RouteHistory {
  const key = routeKey(origin, destination);
  const live = liveHistoryCache.get(key);
  // One observed fare beats any number of samples, so the series turns live the moment
  // we have read a real price - waiting for a second day would mean showing a customer
  // fabricated numbers while a genuine one sits in storage. The window is never
  // reported as zero: a single reading represents one day, and a zero would make the
  // chart label this live series as a sample one.
  if (live && live.length >= 1) {
    return { points: live.slice(), source: "live", windowDays: Math.max(1, windowSpanDays(live)) };
  }
  const known = seedHistory[key];
  if (known) {
    // Seed rows are weekly samples, so the real window is points x 7 days.
    return { points: known, source: "seed", windowDays: known.length * 7 };
  }
  const synthetic = Array.from({ length: 8 }, (_, index) => ({ date: `Week ${index + 1}`, price: 480 + index * 22 }));
  return { points: synthetic, source: "estimate", windowDays: synthetic.length * 7 };
}

export function getSeedHistory(origin: string, destination: string) {
  return getRouteHistory(origin, destination).points;
}

export function getHistoricalAverage(origin: string, destination: string) {
  const points = getSeedHistory(origin, destination);
  return Math.round(points.reduce((sum, point) => sum + point.price, 0) / points.length);
}

/**
 * Live fares come from an ordered chain of $0 suppliers, so running out of one pool
 * never stops us serving customers:
 *
 *   1. Scrappa (Google Flights) - 500 credits/month, recurring, no card on file
 *   2. Ignav                   - 1,000 credits, one-time, no card on file
 *
 * Order is deliberate: spend the pool that refills every month before the one that
 * does not. A supplier is only consulted when its key is configured, and it costs
 * nothing to fail over (a failed request is not billed).
 *
 * This is the ONLY path allowed to emit a "Live fare". Every failure mode - no key,
 * out of credits (402), rate limited (429), upstream outage (503), timeout, empty
 * result - moves to the next supplier, and if none answer we return null so the
 * caller falls through to the sample/estimate path, which is labelled as such. We
 * never invent a price and present it as live.
 *
 * Hard rule: both legs of one search come from the SAME supplier. If a supplier can
 * price the outbound but not the return, we restart the search on the next supplier
 * instead of stitching two sources into a single total.
 */
type LiveLeg = { origin: string; destination: string; date: string; passengers: number };

/** The normalised row every supplier must produce. */
type RawFare = {
  price: number;
  currency: string;
  durationMinutes: number;
  stops: number;
  airline: string;
  airlineCode: string;
  departureTime: string;
  arrivalTime: string;
  /** Omitted entirely when the supplier did not tell us - never guessed. */
  baggage?: string;
};

type LiveProvider = {
  /** Stamped onto every offer, so a supplier swap can never look like a price move. */
  id: string;
  /** Environment variable holding this supplier's key. Unset = supplier skipped. */
  envKey: string;
  search: (leg: LiveLeg, apiKey: string) => Promise<RawFare[] | null>;
};

// Safety net so a burst of searches cannot exhaust every free allowance in one
// sitting. Counts only successful, non-empty responses (those are what get billed).
//
// Two separate pools, not one: public search may only ever spend its own budget, so
// a busy day of anonymous searches can never starve the tracked-route refreshes that
// paying subscribers are waiting on. Without this split the two compete for the same
// counter and the free traffic always wins, because there is far more of it.
//
// Per-instance and therefore best-effort - serverless memory is not shared - with the
// caches below doing most of the work. A true month-wide total needs the database.
type LivePurpose = "search" | "alert";

const LIVE_BUDGET_PER_INSTANCE: Record<LivePurpose, number> = {
  search: 40,
  alert: 20,
};

const liveChargedThisInstance: Record<LivePurpose, number> = { search: 0, alert: 0 };

const liveBudgetExhausted = (purpose: LivePurpose) => liveChargedThisInstance[purpose] >= LIVE_BUDGET_PER_INSTANCE[purpose];

/**
 * Charges the per-instance pool AND the month-wide supplier quota.
 *
 * The two are different things: `liveChargedThisInstance` caps one container so a
 * burst of searches cannot burn every free allowance in a sitting, while the quota
 * ledger is the month-wide total across all instances - the only number that can
 * tell us we are 75% of the way to an empty pool (E14). Both are incremented at the
 * same instant, and only ever for a request the supplier actually answered.
 */
const chargeLiveSearch = async (purpose: LivePurpose, supplierName?: string) => {
  liveChargedThisInstance[purpose] += 1;
  // Awaited rather than fire-and-forget: a serverless runtime freezes the container
  // as soon as the response is sent, so a write left in flight is a credit spent but
  // never recorded - and an undercount delays the very warning E14 exists to give.
  if (supplierName) await chargeQuota(supplierName);
};

/**
 * Budget state, exposed so the cron can escalate when the alert pool runs dry instead
 * of degrading quietly. Escalation E3: a silent budget is a missed alert discovered by
 * a customer rather than by us.
 */
export type LiveBudgetSnapshot = Record<LivePurpose, { used: number; limit: number; exhausted: boolean }>;

export function liveBudgetStatus(): LiveBudgetSnapshot {
  return {
    search: { used: liveChargedThisInstance.search, limit: LIVE_BUDGET_PER_INSTANCE.search, exhausted: liveBudgetExhausted("search") },
    alert: { used: liveChargedThisInstance.alert, limit: LIVE_BUDGET_PER_INSTANCE.alert, exhausted: liveBudgetExhausted("alert") },
  };
}

type ScrappaLeg = {
  airline?: string;
  flight_number?: string;
  departure_airport?: string;
  arrival_airport?: string;
  departure_time?: string;
  arrival_time?: string;
  duration_minutes?: number;
};

type ScrappaFlight = {
  price?: number;
  currency?: string;
  total_duration_minutes?: number;
  stops?: number;
  airline_name?: string;
  legs?: ScrappaLeg[];
};

const formatDuration = (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
const clockTime = (iso?: string) => (iso && iso.length >= 16 ? iso.slice(11, 16) : "--:--");

const scrappaProvider: LiveProvider = {
  id: "Google Flights",
  envKey: "SCRAPPA_API_KEY",
  async search(leg, apiKey) {
    try {
      const url = new URL("https://scrappa.co/api/flights/one-way");
      url.searchParams.set("origin", leg.origin);
      url.searchParams.set("destination", leg.destination);
      url.searchParams.set("departure_date", leg.date);
      url.searchParams.set("adults", String(Math.min(9, Math.max(1, leg.passengers))));
      url.searchParams.set("sort_by", "cheapest");

      const response = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return null;

      const payload = (await response.json()) as { flights?: ScrappaFlight[] };
      const flights = Array.isArray(payload.flights) ? payload.flights : [];
      if (flights.length === 0) return null;

      return flights.slice(0, 6).map(flight => {
        const segments = Array.isArray(flight.legs) ? flight.legs : [];
        const first = segments[0] ?? {};
        const last = segments[segments.length - 1] ?? first;
        return {
          price: flight.price ?? 0,
          currency: flight.currency || "USD",
          durationMinutes: flight.total_duration_minutes ?? 0,
          stops: flight.stops ?? 0,
          airline: flight.airline_name || first.airline || "Airline",
          airlineCode: (first.airline || "").slice(0, 2).toUpperCase() || "FL",
          departureTime: clockTime(first.departure_time),
          arrivalTime: clockTime(last.arrival_time),
          // Deliberately no baggage field: this endpoint does not return one.
        } satisfies RawFare;
      });
    } catch {
      return null;
    }
  },
};

type IgnavSegment = {
  marketing_carrier_code?: string | null;
  operating_carrier_name?: string | null;
  departure_time_local?: string;
  arrival_time_local?: string;
};

type IgnavItinerary = {
  price?: { amount?: number; currency?: string };
  outbound?: { carrier?: string; duration_minutes?: number; segments?: IgnavSegment[] };
  bags?: { carry_on?: number; checked?: number };
};

/** Only ever states baggage counts Ignav actually returned; undefined = not told. */
function formatIgnavBags(bags?: { carry_on?: number; checked?: number }): string | undefined {
  if (!bags) return undefined;
  const carryOn = bags.carry_on ?? 0;
  const checked = bags.checked ?? 0;
  if (carryOn === 0 && checked === 0) return "No bags included";
  const parts: string[] = [];
  if (carryOn > 0) parts.push(`${carryOn} carry-on`);
  if (checked > 0) parts.push(`${checked} checked bag${checked === 1 ? "" : "s"}`);
  return parts.join(" + ");
}

const ignavProvider: LiveProvider = {
  id: "Ignav",
  envKey: "IGNAV_API_KEY",
  async search(leg, apiKey) {
    try {
      const response = await fetch("https://ignav.com/api/fares/one-way", {
        method: "POST",
        headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: leg.origin,
          destination: leg.destination,
          departure_date: leg.date,
          adults: Math.min(9, Math.max(1, leg.passengers)),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return null;

      const payload = (await response.json()) as { itineraries?: IgnavItinerary[] };
      const itineraries = Array.isArray(payload.itineraries) ? payload.itineraries : [];
      if (itineraries.length === 0) return null;

      return itineraries.slice(0, 6).map(itinerary => {
        const outbound = itinerary.outbound ?? {};
        const segments = Array.isArray(outbound.segments) ? outbound.segments : [];
        const first = segments[0] ?? {};
        const last = segments[segments.length - 1] ?? first;
        return {
          price: itinerary.price?.amount ?? 0,
          currency: itinerary.price?.currency || "USD",
          durationMinutes: outbound.duration_minutes ?? 0,
          // Ignav returns every segment, so stops = segments - 1.
          stops: Math.max(0, segments.length - 1),
          airline: outbound.carrier || first.operating_carrier_name || "Airline",
          airlineCode: (first.marketing_carrier_code || "").toUpperCase() || "FL",
          departureTime: clockTime(first.departure_time_local),
          arrivalTime: clockTime(last.arrival_time_local),
          baggage: formatIgnavBags(itinerary.bags),
        } satisfies RawFare;
      });
    } catch {
      return null;
    }
  },
};

// Recurring pool first, one-time pool second. Cheap to extend: append another
// supplier with an id, an env key and a parser.
const LIVE_PROVIDERS: LiveProvider[] = [scrappaProvider, ignavProvider];

function toOffer(fare: RawFare, leg: LiveLeg, providerId: string, index: number): FlightOffer {
  return {
    id: `live-${leg.origin}-${leg.destination}-${leg.date}-${index}`,
    airline: fare.airline,
    airlineCode: fare.airlineCode,
    origin: leg.origin,
    destination: leg.destination,
    departureDate: leg.date,
    departureTime: fare.departureTime,
    arrivalTime: fare.arrivalTime,
    duration: fare.durationMinutes > 0 ? formatDuration(fare.durationMinutes) : "—",
    stops: fare.stops,
    price: fare.price,
    currency: fare.currency,
    cabin: "Economy",
    baggage: fare.baggage ?? "Baggage shown at booking",
    bookingUrl: `https://www.google.com/travel/flights?q=${encodeURIComponent(`${leg.origin} to ${leg.destination}`)}`,
    isBest: index === 0,
    source: "Live fare",
    provider: providerId,
  };
}

/**
 * Per-leg cache. A round trip costs two credits (outbound + return), but users
 * routinely hold the outbound fixed and only change the return date - caching each
 * leg independently makes those edits free instead of re-billing the whole search.
 * Failures are deliberately not cached: a transient error must stay retryable, and
 * a failed request costs no credit anyway.
 */
const liveLegCache = new Map<string, { expiresAt: number; offers: FlightOffer[] }>();
const LIVE_LEG_TTL_MS = 5 * 60 * 1000;
const LIVE_LEG_CACHE_MAX = 300;

function liveLegKey(provider: LiveProvider, leg: LiveLeg) {
  // Supplier is part of the key: two suppliers' prices must never share a cache slot.
  return `${provider.id}|${leg.origin}|${leg.destination}|${leg.date}|${leg.passengers}`;
}

async function getLiveLeg(provider: LiveProvider, leg: LiveLeg, purpose: LivePurpose): Promise<FlightOffer[] | null> {
  const apiKey = process.env[provider.envKey];
  if (!apiKey) return null;

  const key = liveLegKey(provider, leg);
  const cached = liveLegCache.get(key);
  // Cache hits are checked before the budget on purpose: a cached leg costs no
  // credit, so refusing it would throw away a free answer to save money we never spent.
  if (cached && cached.expiresAt > Date.now()) return cached.offers;

  if (liveBudgetExhausted(purpose)) return null;

  const fares = await provider.search(leg, apiKey);
  if (!fares || fares.length === 0) return null;
  await chargeLiveSearch(purpose, provider.id);

  const offers = fares.map((fare, index) => toOffer(fare, leg, provider.id, index)).filter(offer => offer.price > 0);
  if (offers.length === 0) return null;

  // Serverless instances are long-lived but not infinite: evict rather than grow.
  if (liveLegCache.size >= LIVE_LEG_CACHE_MAX) {
    const oldest = liveLegCache.keys().next().value;
    if (oldest !== undefined) liveLegCache.delete(oldest);
  }
  liveLegCache.set(key, { expiresAt: Date.now() + LIVE_LEG_TTL_MS, offers });
  return offers;
}

/**
 * Walk the supplier chain. Each supplier is tried for the WHOLE search; a supplier
 * that cannot price both legs is abandoned for the next one, so a single total is
 * never stitched from two sources. Returns null when every configured supplier is
 * unavailable - the caller then serves the honestly-labelled sample path, and the
 * customer still gets an answer instead of an error.
 */
async function searchLiveFares(input: {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  passengers: number;
  tripType?: "roundTrip" | "oneWay";
  /** Which pool this search is allowed to spend. Defaults to "search"; the
   *  tracked-route scanner passes "alert" so its budget stays ring-fenced. */
  purpose?: LivePurpose;
}): Promise<FlightOffer[] | null> {
  const outboundLeg: LiveLeg = { origin: input.origin, destination: input.destination, date: input.departureDate, passengers: input.passengers };
  const returnLeg: LiveLeg = { origin: input.destination, destination: input.origin, date: input.returnDate ?? "", passengers: input.passengers };
  const wantsReturn = input.tripType !== "oneWay" && Boolean(input.returnDate);
  const purpose: LivePurpose = input.purpose ?? "search";

  for (const provider of LIVE_PROVIDERS) {
    if (liveBudgetExhausted(purpose)) break;

    const outbound = await getLiveLeg(provider, outboundLeg, purpose);
    if (!outbound) continue; // no key, no credits, outage, or empty - try next supplier

    let offers = outbound;
    if (wantsReturn) {
      const back = await getLiveLeg(provider, returnLeg, purpose);
      if (!back) continue; // never mix suppliers: restart the whole search elsewhere
      offers = offers.map((out, index) => {
        const leg = back[index % back.length];
        return { ...out, price: out.price + leg.price, returnPrice: leg.price };
      });
    }

    // Always sort ourselves: the cheapest must be flagged regardless of the order
    // (or claimed sort order) the supplier returned.
    return [...offers].sort((a, b) => a.price - b.price).map((offer, index) => ({ ...offer, isBest: index === 0 }));
  }

  return null;
}

export async function searchFlights(
  input: { origin: string; destination: string; departureDate: string; returnDate?: string; passengers: number; tripType?: "roundTrip" | "oneWay" },
  purpose: LivePurpose = "search",
) {
  const origin = input.origin.toUpperCase();
  const destination = input.destination.toUpperCase();
  const cacheKey = JSON.stringify({ ...input, origin, destination });
  const cached = cachedResults.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { offers: cached.offers, cached: true, source: cached.source };

  // Live fares first: walk the supplier chain. If none can answer we fall through to
  // the sample/estimate path, which is labelled honestly in the UI - a customer
  // always gets an answer, never an error and never a fake "live" price.
  const liveOffers = await searchLiveFares({ ...input, origin, destination, purpose });
  if (liveOffers && liveOffers.length > 0) {
    cachedResults.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1000, offers: liveOffers, source: "live" });
    return { offers: liveOffers, cached: false, source: "live" as const };
  }

  const matching = seedOffers.filter(offer => offer.origin === origin && offer.destination === destination);
  let offers = matching.length > 0
    ? matching.map(offer => ({ ...offer, departureDate: input.departureDate, isBest: false })).sort((a, b) => a.price - b.price).map((offer, index) => ({ ...offer, isBest: index === 0 }))
    : buildFallbackOffers(origin, destination, input.departureDate);
  let estimate = matching.length === 0;
  // Round trip = outbound + return leg. Fixed 2026-09-27: the Return button used to show one-way-only prices.
  if (input.tripType !== "oneWay" && input.returnDate) {
    const backMatches = seedOffers.filter(offer => offer.origin === destination && offer.destination === origin);
    const backOffers = backMatches.length > 0
      ? backMatches.map(offer => ({ ...offer, departureDate: input.returnDate as string, isBest: false })).sort((a, b) => a.price - b.price)
      : buildFallbackOffers(destination, origin, input.returnDate);
    estimate = estimate || backMatches.length === 0;
    offers = offers
      .map((outbound, index) => {
        const back = backOffers[index % backOffers.length];
        return { ...outbound, price: outbound.price + back.price, returnPrice: back.price };
      })
      .sort((a, b) => a.price - b.price)
      .map((offer, index) => ({ ...offer, isBest: index === 0 }));
  }
  const source: "seed" | "estimate" = estimate ? "estimate" : "seed";
  cachedResults.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1000, offers, source });
  return { offers, cached: false, source };
}

function buildFallbackOffers(origin: string, destination: string, departureDate: string): FlightOffer[] {
  const base = 330 + ((origin.charCodeAt(0) + destination.charCodeAt(0)) % 6) * 84;
  const airlines = [
    ["Air France", "AF", "13:20", "06:40", "10h 20m", 1],
    ["Lufthansa", "LH", "16:45", "11:15", "11h 30m", 1],
    ["Qatar Airways", "QR", "21:10", "18:05", "14h 55m", 1],
    ["Turkish Airlines", "TK", "09:35", "07:50", "12h 15m", 1],
    ["Etihad Airways", "EY", "22:20", "19:40", "14h 20m", 1],
    ["Singapore Airlines", "SQ", "11:10", "08:35", "13h 25m", 1],
    ["Emirates", "EK", "15:45", "12:10", "14h 25m", 1],
    ["United Airlines", "UA", "18:25", "09:15", "9h 50m", 0],
  ] as const;
  return airlines.map(([airline, airlineCode, departureTime, arrivalTime, duration, stops], index) => ({ id: `fallback-${origin}-${destination}-${index}`, airline, airlineCode, origin, destination, departureDate, departureTime, arrivalTime, duration, stops, price: base + index * 78, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: `https://www.google.com/travel/flights?q=${origin}%20to%20${destination}`, isBest: index === 0, layoverCountry: stops > 0 ? ["France", "Germany", "Qatar", "Türkiye", "United Arab Emirates", "Singapore", "United States"][index] : undefined, source: "Estimate" }));
}

export function listTrackedRoutes() {
  return Array.from(trackedRoutes.values());
}

/**
 * Saves a tracked route.
 *
 * Storage is awaited rather than fire-and-forget: a response that returns before
 * the row lands can be frozen out of the write, and the customer would watch their
 * saved route reappear as a demo route on the next cold start. Hydration runs first
 * so it cannot later clear a route we have just added.
 */
export async function addTrackedRoute(input: Omit<TrackedRoute, "id" | "currentPrice" | "historicalAverage" | "lastChecked" | "status">) {
  await ensureRoutesHydrated();
  const id = `route-${Date.now()}`;
  const currentPrice = seedOffers.find(offer => offer.origin === input.origin && offer.destination === input.destination)?.price ?? Math.round(getHistoricalAverage(input.origin, input.destination) * 0.92);
  const route: TrackedRoute = { ...input, id, currentPrice, historicalAverage: getHistoricalAverage(input.origin, input.destination), lastChecked: "just now", status: currentPrice <= input.targetPrice ? "alert" : "watching" };
  trackedRoutes.set(id, route);
  await persistRoute(toPersistable(route, new Date()));
  return route;
}

export async function removeTrackedRoute(id: string) {
  await ensureRoutesHydrated();
  const removed = trackedRoutes.delete(id);
  // The in-memory delete already happened; the row is removed too so the route
  // cannot resurrect itself on the next cold start.
  await removePersistedRoute(id);
  return removed;
}

export async function scanTrackedRoutes() {
  // Restore saved routes first. Pricing a cold-started container's demo routes would
  // both miss the customer's real watch list and report a clean run over it.
  const hydrated = await ensureRoutesHydrated();
  const routes = listTrackedRoutes();
  let liveRefreshed = 0;
  let liveProviders = 0;
  let observationsStored = 0;
  // Which suppliers actually served this run. A count alone hides drift: if the
  // monthly-refilling pool stops answering and the one-time pool takes over, "4
  // suppliers" looks identical to a healthy run while capacity quietly drains.
  const suppliersServed = new Set<string>();

  // Refresh against live fares BEFORE deciding anything. The previous version compared
  // currentPrice against the target without ever asking a supplier, so every "price
  // drop" was really a comparison against the seed value the route was created with.
  // A route that cannot be priced live keeps its existing price rather than being
  // quietly back-filled with sample data.
  for (const route of routes) {
    const result = await searchFlights(
      {
        origin: route.origin,
        destination: route.destination,
        departureDate: route.departDate,
        returnDate: route.returnDate || undefined,
        passengers: 1,
        tripType: route.returnDate ? "roundTrip" : "oneWay",
      },
      "alert",
    );
    const liveOffer = result.source === "live" ? result.offers[0] : undefined;
    if (!liveOffer || liveOffer.price <= 0) continue;

    liveRefreshed += 1;
    if (liveOffer.provider) liveProviders += 1;
    if (liveOffer.provider) suppliersServed.add(liveOffer.provider);
    trackedRoutes.set(route.id, { ...route, currentPrice: liveOffer.price, lastChecked: "just now" });
    const checkedAt = new Date();
    lastCheckedAtById.set(route.id, checkedAt);

    // This is the asset: one durable, supplier-tagged reading of a real fare. It is
    // written only when a supplier actually answered, so the series can never be
    // padded with sample numbers to look busier than it is.
    const stored = await recordPricePoint({
      origin: route.origin,
      destination: route.destination,
      departDate: route.departDate,
      price: liveOffer.price,
      currency: liveOffer.currency,
      provider: liveOffer.provider ?? "unknown",
      purpose: "scan",
      routeId: route.id,
    });
    if (stored) {
      observationsStored += 1;
      // Drop the cached series so the next read shows what was just recorded.
      invalidateHistory(route.origin, route.destination);
    }
  }

  // Persisted after pricing, never before: the row must reflect the price we last
  // actually observed, not the sample value the route was created with.
  const persistQueue: Array<Promise<unknown>> = [];

  // Load every route's live series BEFORE any alert is decided. Without this the
  // average is still the value the route was seeded with, so each drop percentage is
  // measured against a number no supplier ever quoted - which is precisely the fault
  // this storage was introduced to remove.
  await Promise.all(routes.map(route => ensureHistoryLoaded(route.origin, route.destination)));

  const alerts = listTrackedRoutes().map(route => {
    // Recomputed rather than trusted from creation time. Once live readings exist the
    // average must follow them, otherwise every drop percentage is still measured
    // against the value the route happened to be seeded with.
    const historicalAverage = getHistoricalAverage(route.origin, route.destination) || route.historicalAverage;
    const dropPercent = historicalAverage > 0 ? Math.round((1 - route.currentPrice / historicalAverage) * 100) : 0;
    const isAlert = route.currentPrice <= route.targetPrice || dropPercent >= 15;
    const updated = { ...route, historicalAverage, status: isAlert ? "alert" as const : "watching" as const, lastChecked: route.lastChecked };
    trackedRoutes.set(route.id, updated);
    persistQueue.push(persistRoute(toPersistable(updated, lastCheckedAtById.get(updated.id) ?? null)));
    return { route: updated, dropPercent, notified: isAlert };
  });
  // Awaited rather than fired and forgotten: returning is what lets the runtime
  // freeze this instance, so a write still in flight here is a write we lose.
  await Promise.all(persistQueue);
  // liveRefreshed is reported so a caller can never claim "all routes checked" when
  // only some of them were actually priced by a supplier. observationsStored says the
  // same for the history table - an attempt and a stored row are not the same thing.
  return { checkedAt: new Date().toISOString(), routesTotal: routes.length, liveRefreshed, liveProviders, suppliers: Array.from(suppliersServed), observationsStored, hydrated, alerts };
}

export interface NotificationResult {
  channel: "Telegram" | "WhatsApp";
  message: string;
  /** True ONLY when the provider actually accepted the message. It is never
   *  inferred from credentials being present - a configured-but-broken bot must
   *  not be able to report success. */
  delivered: boolean;
  reason: string;
}

export async function sendPriceDropNotification(route: TrackedRoute, dropPercent: number): Promise<NotificationResult> {
  const message = `✈️ Price drop on ${route.origin} → ${route.destination}: $${route.currentPrice} (${dropPercent}% below average). Your target is $${route.targetPrice}.`;

  if (route.alertChannel === "Telegram") {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return { channel: "Telegram", message, delivered: false, reason: "Telegram credentials not configured" };
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
      if (!res.ok) return { channel: "Telegram", message, delivered: false, reason: `Telegram API responded ${res.status}` };
      const body = (await res.json()) as { ok?: boolean; description?: string };
      if (!body.ok) return { channel: "Telegram", message, delivered: false, reason: body.description || "Telegram rejected the message" };
      return { channel: "Telegram", message, delivered: true, reason: "accepted by Telegram" };
    } catch (error) {
      return { channel: "Telegram", message, delivered: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // Twilio/WhatsApp is still a placeholder. Say so instead of reporting a delivery
  // that never happened - the previous version returned delivered:true here.
  return { channel: "WhatsApp", message, delivered: false, reason: "WhatsApp alerts are not implemented yet" };
}
