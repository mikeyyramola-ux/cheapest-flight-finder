import { afterEach, describe, expect, it, vi } from "vitest";
import { searchFlights } from "./flight-data";

/**
 * Honesty guarantee for P4: "Live fare" may only appear when a real provider
 * response was mapped. If the provider is absent, rejects us, or cannot price
 * the whole itinerary, we must fall back to the path the UI labels as sample.
 */

const KEY = "scrappa-test-key";

function providerReply(flights: Array<Record<string, unknown>>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ flights }),
  };
}

/** Ignav's documented response shape: itineraries[] with price/outbound/segments/bags. */
function ignavReply(itineraries: Array<Record<string, unknown>> = [{
  price: { amount: 512, currency: "USD" },
  outbound: {
    carrier: "Delta",
    duration_minutes: 420,
    segments: [
      { marketing_carrier_code: "DL", departure_time_local: "2026-12-05T09:00:00", arrival_time_local: "2026-12-05T17:00:00" },
    ],
  },
  bags: { carry_on: 1, checked: 1 },
}]) {
  return { ok: true, status: 200, json: async () => ({ itineraries }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("live fare source", () => {
  it("never claims live when no provider key is configured", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", "");
    const result = await searchFlights({
      origin: "SFO",
      destination: "NRT",
      departureDate: "2026-12-03",
      passengers: 1,
      tripType: "oneWay",
    });
    expect(result.source).not.toBe("live");
    expect(result.offers.every(offer => offer.source !== "Live fare")).toBe(true);
  });

  it("maps a real provider response to Live fares, cheapest first", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => providerReply([
      {
        price: 602,
        currency: "USD",
        total_duration_minutes: 415,
        stops: 0,
        airline_name: "American",
        legs: [{ airline: "AA", departure_time: "2026-12-03T10:00:00", arrival_time: "2026-12-03T18:00:00" }],
      },
      {
        price: 444,
        currency: "USD",
        total_duration_minutes: 434,
        stops: 0,
        airline_name: "Virgin Atlantic",
        legs: [{ airline: "VS", departure_time: "2026-12-03T19:01:00", arrival_time: "2026-12-04T07:15:00" }],
      },
    ])));

    const result = await searchFlights({
      origin: "JFK",
      destination: "LHR",
      departureDate: "2026-12-03",
      passengers: 1,
      tripType: "oneWay",
    });

    expect(result.source).toBe("live");
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every(offer => offer.source === "Live fare")).toBe(true);
    // Every live fare must name its supplier, so a future supplier swap can never
    // be misread as a price movement.
    expect(result.offers.every(offer => offer.provider === "Google Flights")).toBe(true);
    expect(result.offers[0].price).toBeLessThanOrEqual(result.offers[1].price);
    expect(result.offers[0].isBest).toBe(true);
    expect(result.offers[0].departureTime).toBe("19:01");
    expect(result.offers[0].duration).toBe("7h 14m");
    expect(result.offers[0].airline).toBe("Virgin Atlantic");
    // No baggage claim on data the provider does not return.
    expect(result.offers[0].baggage).toBe("Baggage shown at booking");
  });

  it("falls back rather than passing a one-way total off as a round-trip price", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const target = String(url);
      // Outbound (destination=BBB) answers; the return leg (destination=AAA) does not.
      if (target.includes("destination=AAA")) return { ok: false, status: 503, json: async () => ({}) };
      return providerReply([{
        price: 500,
        currency: "USD",
        total_duration_minutes: 400,
        stops: 0,
        airline_name: "Test Air",
        legs: [{ airline: "TT", departure_time: "2026-12-03T10:00:00", arrival_time: "2026-12-03T18:00:00" }],
      }]);
    }));

    const result = await searchFlights({
      origin: "AAA",
      destination: "BBB",
      departureDate: "2026-12-03",
      returnDate: "2026-12-10",
      passengers: 1,
      tripType: "roundTrip",
    });

    expect(result.source).not.toBe("live");
    expect(result.offers.every(offer => offer.source !== "Live fare")).toBe(true);
  });

  it("falls back when the provider is rate limited or out of credits", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    for (const status of [402, 429, 503]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, json: async () => ({}) })));
      const result = await searchFlights({
        origin: "CCC",
        destination: `D${status}`,
        departureDate: "2026-12-03",
        passengers: 1,
        tripType: "oneWay",
      });
      expect(result.source).not.toBe("live");
    }
  });

  it("caches each leg, so changing only the return date costs one call not two", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    const fetchMock = vi.fn(async () => providerReply([{
      price: 300,
      currency: "USD",
      total_duration_minutes: 480,
      stops: 0,
      airline_name: "Cache Air",
      legs: [{ airline: "CA", departure_time: "2026-11-04T09:00:00", arrival_time: "2026-11-04T21:00:00" }],
    }]));
    vi.stubGlobal("fetch", fetchMock);

    const base = { origin: "LAX", destination: "AMS", departureDate: "2026-11-04", passengers: 1, tripType: "roundTrip" as const };

    const first = await searchFlights({ ...base, returnDate: "2026-11-11" });
    expect(first.source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(2); // outbound + return

    const repeat = await searchFlights({ ...base, returnDate: "2026-11-11" });
    expect(repeat.cached).toBe(true);
    expect(repeat.source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(2); // whole result cached

    const laterReturn = await searchFlights({ ...base, returnDate: "2026-11-18" });
    expect(laterReturn.source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(3); // outbound reused, only the new leg billed
    expect(laterReturn.offers[0].provider).toBe("Google Flights");
  });

  it("fails over to the backup supplier when the primary is out of credits", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", "primary-key");
    vi.stubEnv("IGNAV_API_KEY", "backup-key");
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const target = String(url);
      if (target.includes("scrappa.co")) return { ok: false, status: 402, json: async () => ({}) };
      return ignavReply();
    }));

    const result = await searchFlights({
      origin: "MAD",
      destination: "FCO",
      departureDate: "2026-12-07",
      passengers: 1,
      tripType: "oneWay",
    });

    expect(result.source).toBe("live");
    expect(result.offers[0].provider).toBe("Ignav");
    expect(result.offers[0].airline).toBe("Delta");
    expect(result.offers[0].airlineCode).toBe("DL");
    expect(result.offers[0].stops).toBe(0);
    expect(result.offers[0].price).toBe(512);
    expect(result.offers[0].departureTime).toBe("09:00");
    // Baggage only because Ignav actually returned it.
    expect(result.offers[0].baggage).toBe("1 carry-on + 1 checked bag");
  });

  it("restarts the whole round trip on the next supplier instead of mixing two", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", "primary-key");
    vi.stubEnv("IGNAV_API_KEY", "backup-key");
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string) => {
      const target = String(url);
      if (target.includes("scrappa.co")) {
        // Outbound answers, return leg is broken - this supplier must be abandoned whole.
        if (target.includes("destination=SFO")) return { ok: false, status: 503, json: async () => ({}) };
        return providerReply([{
          price: 400, currency: "USD", total_duration_minutes: 300, stops: 0, airline_name: "Test Air",
          legs: [{ airline: "TT", departure_time: "2026-12-09T08:00:00", arrival_time: "2026-12-09T13:00:00" }],
        }]);
      }
      return ignavReply();
    }));

    const result = await searchFlights({
      origin: "SFO",
      destination: "SEA",
      departureDate: "2026-12-09",
      returnDate: "2026-12-16",
      passengers: 1,
      tripType: "roundTrip",
    });

    expect(result.source).toBe("live");
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every(offer => offer.provider === "Ignav")).toBe(true);
    expect(result.offers[0].price).toBe(1024); // 512 out + 512 back, one supplier only
  });

  it("serves the labelled sample path when every supplier is down", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", "primary-key");
    vi.stubEnv("IGNAV_API_KEY", "backup-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    const result = await searchFlights({
      origin: "YYZ",
      destination: "NRT",
      departureDate: "2026-12-11",
      passengers: 1,
      tripType: "oneWay",
    });

    expect(result.source).not.toBe("live");
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every(offer => offer.source !== "Live fare")).toBe(true);
  });
});
