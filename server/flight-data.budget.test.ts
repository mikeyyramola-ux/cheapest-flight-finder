import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Credit ring-fence.
 *
 * Free allowances are finite (Scrappa 500/month, Ignav 1,000 one-time) and the
 * product promise is that a paying subscriber's price-drop alert is never missed.
 * Public search and tracked-route refreshes therefore draw on SEPARATE budgets:
 * exhausting one must leave the other untouched.
 *
 * The counters, the result cache and the leg cache are all module-level, so every
 * test re-imports a fresh copy of the module - otherwise one test would assert
 * against a budget the previous test had already drained.
 */

const KEY = "budget-test-key";

type SearchFlights = typeof import("./flight-data").searchFlights;

let searchFlights: SearchFlights;

const providerReply = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    flights: [
      {
        price: 300,
        currency: "USD",
        total_duration_minutes: 420,
        stops: 0,
        airline_name: "Test Air",
        legs: [{ airline: "TT", departure_time: "2027-01-01T10:00:00", arrival_time: "2027-01-01T18:00:00" }],
      },
    ],
  }),
});

/** Distinct date per call so neither the result cache nor the leg cache can answer. */
const dateFor = (i: number) => {
  const d = new Date(Date.UTC(2027, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

const oneWay = (departureDate: string, purpose?: "search" | "alert") =>
  searchFlights({ origin: "SFO", destination: "NRT", departureDate, passengers: 1, tripType: "oneWay" }, purpose);

/** Burns the named budget until live fares stop, returning how many were served. */
async function exhaust(purpose: "search" | "alert", startIndex: number) {
  for (let i = 0; i < 120; i += 1) {
    const result = await oneWay(dateFor(startIndex + i), purpose);
    if (result.source !== "live") return i;
  }
  throw new Error(`${purpose} budget never capped - the ring-fence is not enforcing anything`);
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("SCRAPPA_API_KEY", KEY);
  vi.stubEnv("IGNAV_API_KEY", "");
  vi.stubGlobal("fetch", vi.fn(async () => providerReply()));
  ({ searchFlights } = await import("./flight-data"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("credit ring-fence", () => {
  it("stops public search when its own budget is spent", async () => {
    const used = await exhaust("search", 0);
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(120);

    const after = await oneWay(dateFor(500));
    expect(after.source).not.toBe("live");
    expect(after.offers.every(offer => offer.source !== "Live fare")).toBe(true);
  });

  it("leaves the alert budget untouched when public search is exhausted", async () => {
    await exhaust("search", 0);

    // The whole point: a paying subscriber's route refresh must still be priced
    // after anonymous traffic has burned the entire public pool.
    const alertResult = await oneWay(dateFor(500), "alert");
    expect(alertResult.source).toBe("live");
    expect(alertResult.offers[0]?.source).toBe("Live fare");
  });

  it("caps the alert pool too, and never above the public pool", async () => {
    const searchUsed = await exhaust("search", 0);
    const alertUsed = await exhaust("alert", 2000);

    expect(alertUsed).toBeGreaterThan(0);
    expect(alertUsed).toBeLessThanOrEqual(searchUsed);
  });
});
