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
  source: "Seed data" | "Amadeus API";
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

const cachedResults = new Map<string, { expiresAt: number; offers: FlightOffer[] }>();
const DEFAULT_ROUTES: TrackedRoute[] = [
  { id: "route-1", origin: "JFK", destination: "LHR", departDate: isoDate(45), returnDate: isoDate(52), targetPrice: 450, currentPrice: 418, historicalAverage: 532, lastChecked: "12 min ago", status: "alert", alertChannel: "Telegram" },
  { id: "route-2", origin: "LHR", destination: "HND", departDate: isoDate(60), returnDate: isoDate(74), targetPrice: 760, currentPrice: 806, historicalAverage: 899, lastChecked: "12 min ago", status: "watching", alertChannel: "WhatsApp" },
];

const trackedRoutes = new Map(DEFAULT_ROUTES.map(route => [route.id, route]));

export function routeKey(origin: string, destination: string) {
  return `${origin.toUpperCase()}-${destination.toUpperCase()}`;
}

export function getSeedHistory(origin: string, destination: string) {
  const key = routeKey(origin, destination);
  return seedHistory[key] ?? Array.from({ length: 8 }, (_, index) => ({ date: `Week ${index + 1}`, price: 480 + index * 22 }));
}

export function getHistoricalAverage(origin: string, destination: string) {
  const points = getSeedHistory(origin, destination);
  return Math.round(points.reduce((sum, point) => sum + point.price, 0) / points.length);
}

export async function searchFlights(input: { origin: string; destination: string; departureDate: string; returnDate?: string; passengers: number }) {
  const origin = input.origin.toUpperCase();
  const destination = input.destination.toUpperCase();
  const cacheKey = JSON.stringify({ ...input, origin, destination });
  const cached = cachedResults.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { offers: cached.offers, cached: true, source: "cache" as const };

  const matching = seedOffers.filter(offer => offer.origin === origin && offer.destination === destination);
  const offers = matching.length > 0
    ? matching.map(offer => ({ ...offer, departureDate: input.departureDate, isBest: false })).sort((a, b) => a.price - b.price).map((offer, index) => ({ ...offer, isBest: index === 0 }))
    : buildFallbackOffers(origin, destination, input.departureDate);
  cachedResults.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1000, offers });
  return { offers, cached: false, source: process.env.AMADEUS_CLIENT_ID ? "amadeus-ready" as const : "seed" as const };
}

function buildFallbackOffers(origin: string, destination: string, departureDate: string): FlightOffer[] {
  const base = 330 + ((origin.charCodeAt(0) + destination.charCodeAt(0)) % 6) * 84;
  const airlines = [
    ["Air France", "AF", "13:20", "06:40", "10h 20m", 1],
    ["Lufthansa", "LH", "16:45", "11:15", "11h 30m", 1],
    ["Qatar Airways", "QR", "21:10", "18:05", "14h 55m", 1],
  ] as const;
  return airlines.map(([airline, airlineCode, departureTime, arrivalTime, duration, stops], index) => ({ id: `fallback-${origin}-${destination}-${index}`, airline, airlineCode, origin, destination, departureDate, departureTime, arrivalTime, duration, stops, price: base + index * 78, currency: "USD", cabin: "Economy", baggage: "1 carry-on", bookingUrl: `https://www.google.com/travel/flights?q=${origin}%20to%20${destination}`, isBest: index === 0, source: "Seed data" }));
}

export function listTrackedRoutes() {
  return Array.from(trackedRoutes.values());
}

export function addTrackedRoute(input: Omit<TrackedRoute, "id" | "currentPrice" | "historicalAverage" | "lastChecked" | "status">) {
  const id = `route-${Date.now()}`;
  const currentPrice = seedOffers.find(offer => offer.origin === input.origin && offer.destination === input.destination)?.price ?? Math.round(getHistoricalAverage(input.origin, input.destination) * 0.92);
  const route: TrackedRoute = { ...input, id, currentPrice, historicalAverage: getHistoricalAverage(input.origin, input.destination), lastChecked: "just now", status: currentPrice <= input.targetPrice ? "alert" : "watching" };
  trackedRoutes.set(id, route);
  return route;
}

export function removeTrackedRoute(id: string) {
  return trackedRoutes.delete(id);
}

export function scanTrackedRoutes() {
  const alerts = listTrackedRoutes().map(route => {
    const dropPercent = Math.round((1 - route.currentPrice / route.historicalAverage) * 100);
    const isAlert = route.currentPrice <= route.targetPrice || dropPercent >= 15;
    const updated = { ...route, status: isAlert ? "alert" as const : "watching" as const, lastChecked: "just now" };
    trackedRoutes.set(route.id, updated);
    return { route: updated, dropPercent, notified: isAlert };
  });
  return { checkedAt: new Date().toISOString(), alerts };
}

export async function sendPriceDropNotification(route: TrackedRoute, dropPercent: number) {
  const message = `✈️ Price drop on ${route.origin} → ${route.destination}: $${route.currentPrice} (${dropPercent}% below average). Your target is $${route.targetPrice}.`;
  if (route.alertChannel === "Telegram" && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message }) });
  }
  if (route.alertChannel === "WhatsApp" && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    // Framework placeholder: wire Twilio's messages.create here when WhatsApp credentials are enabled.
    console.info("[WhatsApp alert ready]", route.id, message);
  }
  return { channel: route.alertChannel, message, delivered: Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.TWILIO_ACCOUNT_SID) };
}
