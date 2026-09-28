import { describe, expect, it, vi } from "vitest";
import { getHistoricalAverage, getRouteHistory, listTrackedRoutes, scanTrackedRoutes, searchFlights, sendPriceDropNotification } from "./flight-data";
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

describe("honesty guarantees", () => {
  it("never labels a sample series as live, and derives the window from the data", () => {
    const seeded = getRouteHistory("JFK", "LHR");
    expect(seeded.source).toBe("seed");
    // The chart used to print a fixed "90-day average" over ~70 days of samples.
    expect(seeded.windowDays).toBe(seeded.points.length * 7);
    expect(seeded.windowDays).toBeLessThan(90);

    const unknown = getRouteHistory("ZZZ", "YYY");
    expect(unknown.source).toBe("estimate");
    expect(unknown.source).not.toBe("live");
  });

  it("reports an alert as undelivered when Telegram is not configured", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    try {
      const route = listTrackedRoutes()[0];
      expect(route).toBeTruthy();
      const result = await sendPriceDropNotification(route!, 22);
      expect(result.delivered).toBe(false);
      expect(result.reason).toMatch(/not configured/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never claims WhatsApp delivery while Twilio is still a placeholder", async () => {
    const route = { ...listTrackedRoutes()[0]!, alertChannel: "WhatsApp" as const };
    const result = await sendPriceDropNotification(route, 22);
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/not implemented/i);
  });
});

describe("premium checkout", () => {
  it("returns a demo checkout destination when Stripe is not configured", async () => {
    const result = await createPremiumCheckout({ origin: "JFK-LHR" });
    expect(result.mode).toBe("demo");
    expect(result.url).toContain("/paywall?checkout=demo");
  });
});
