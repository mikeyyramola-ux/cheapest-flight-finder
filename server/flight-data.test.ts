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

  it("flags tracked routes at or below the target / 15% drop threshold", async () => {
    const average = getHistoricalAverage("JFK", "LHR");
    expect(average).toBeGreaterThan(0);
    const result = await scanTrackedRoutes();
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

  // Credentials now exist in production, so the promise this type makes is a live one
  // rather than a branch nothing can reach. Two sides of it, both against a mocked
  // Telegram: presence of a token must never be mistaken for delivery, and acceptance
  // must be reported for exactly what was accepted.
  it("reports a configured bot that Telegram rejects as undelivered", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "configured-but-rejected");
    vi.stubEnv("TELEGRAM_CHAT_ID", "8063753263");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ ok: false, description: "chat not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await sendPriceDropNotification(listTrackedRoutes()[0]!, 22);
      expect(result.delivered).toBe(false);
      expect(result.reason).toMatch(/403/);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("claims success only for a message Telegram itself accepted, to our own chat", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "configured");
    vi.stubEnv("TELEGRAM_CHAT_ID", "8063753263");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await sendPriceDropNotification(listTrackedRoutes()[0]!, 22);
      expect(result.delivered).toBe(true);
      expect(result.reason).toMatch(/accepted by Telegram/i);
      const init = fetchMock.mock.calls[0]?.[1] as { body: string };
      const sent = JSON.parse(init.body) as { chat_id: string; text: string };
      expect(sent.chat_id).toBe("8063753263");
      expect(sent.text).toContain("Price drop");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe("premium checkout", () => {
  it("returns a demo checkout destination when Stripe is not configured", async () => {
    const result = await createPremiumCheckout({ origin: "JFK-LHR" });
    expect(result.mode).toBe("demo");
    expect(result.url).toContain("/paywall?checkout=demo");
  });
});
