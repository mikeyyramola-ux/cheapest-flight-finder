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
});
