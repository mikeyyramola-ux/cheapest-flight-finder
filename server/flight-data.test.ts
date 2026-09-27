import { describe, expect, it } from "vitest";
import { getHistoricalAverage, listTrackedRoutes, scanTrackedRoutes, searchFlights } from "./flight-data";
import { createPremiumCheckout } from "./stripe";

describe("flight data engine", () => {
  it("totals a round trip as outbound + return leg", async () => {
    const result = await searchFlights({ origin: "JFK", destination: "LHR", departureDate: "2026-10-29", returnDate: "2026-11-05", passengers: 1 });
    expect(result.offers[0]?.price).toBe(719); // 389 seeded outbound + 330 return leg (no seeded LHR-JFK stock)
    expect(result.offers[0]?.returnPrice).toBe(330);
    expect(result.offers[0]?.isBest).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.source).toBe("estimate");
  });

  it("keeps one-way at the outbound-only seeded fare", async () => {
    const result = await searchFlights({ origin: "JFK", destination: "LHR", departureDate: "2026-10-29", passengers: 1, tripType: "oneWay" });
    expect(result.offers[0]?.price).toBe(389);
    expect(result.source).toBe("seed");
  });

  it("serves the same query from the five-minute cache", async () => {
    const input = { origin: "JFK", destination: "LHR", departureDate: "2026-10-29", returnDate: "2026-11-05", passengers: 1 };
    await searchFlights(input);
    const second = await searchFlights(input);
    expect(second.cached).toBe(true);
    expect(second.offers.length).toBeGreaterThan(0);
  });

  it("flags tracked routes at or below the target / 15% drop threshold", () => {
    const average = getHistoricalAverage("JFK", "LHR");
    expect(average).toBeGreaterThan(0);
    const result = scanTrackedRoutes();
    expect(result.alerts.length).toBe(listTrackedRoutes().length);
    expect(result.alerts.some(item => item.notified)).toBe(true);
  });
});

describe("premium checkout", () => {
  it("returns a demo checkout destination when Stripe is not configured", async () => {
    const result = await createPremiumCheckout({ origin: "JFK-LHR" });
    expect(result.mode).toBe("demo");
    expect(result.url).toContain("/paywall?checkout=demo");
  });
});
