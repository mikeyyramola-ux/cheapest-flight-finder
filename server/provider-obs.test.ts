import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fallThroughStats,
  httpReason,
  providerCallStats,
  recentProviderCalls,
  recordFallThrough,
  recordProviderCall,
  resetProviderTelemetry,
  thrownReason,
} from "./provider-obs";

/**
 * PROPOSAL 22: before this, flight-data.ts returned `null` for a 402, a timeout, a
 * missing key and an empty result alike. The provider-quality report could not be
 * produced from history because none of it was ever written down.
 *
 * These tests pin the four things that were missing: status-class counts, latency
 * (median + worst), and how often the chain fell through to the next supplier or all
 * the way to seed.
 */

beforeEach(() => {
  resetProviderTelemetry();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reason buckets", () => {
  it("separates the exact failures the quota audit asked about", () => {
    expect(httpReason(402)).toBe("402");
    expect(httpReason(429)).toBe("429");
    expect(httpReason(500)).toBe("5xx");
    expect(httpReason(503)).toBe("5xx");
    expect(httpReason(404)).toBe("http");
  });

  it("tells a timeout apart from a network failure", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(thrownReason(timeout)).toBe("timeout");
    expect(thrownReason(new Error("ECONNRESET"))).toBe("network");
    expect(thrownReason(undefined)).toBe("network");
  });
});

describe("provider call recording", () => {
  it("reports calls, success rate and latency per provider", () => {
    recordProviderCall({ provider: "Google Flights", ms: 120, ok: true, status: 200, reason: "ok", offers: 6 });
    recordProviderCall({ provider: "Google Flights", ms: 300, ok: true, status: 200, reason: "ok", offers: 4 });
    recordProviderCall({ provider: "Ignav", ms: 800, ok: true, status: 200, reason: "ok", offers: 2 });

    const stats = providerCallStats();
    const scrappa = stats.find(row => row.provider === "Google Flights");
    const ignav = stats.find(row => row.provider === "Ignav");

    expect(scrappa).toMatchObject({ calls: 2, ok: 2, failed: 0, medianMs: 210, worstMs: 300 });
    expect(ignav).toMatchObject({ calls: 1, ok: 1, medianMs: 800, worstMs: 800 });
  });

  it("counts 402 and timeout as their own failures rather than a generic miss", () => {
    recordProviderCall({ provider: "Google Flights", ms: 40, ok: false, status: 402, reason: "402", offers: 0 });
    recordProviderCall({ provider: "Google Flights", ms: 20_000, ok: false, status: null, reason: "timeout", offers: 0 });
    recordProviderCall({ provider: "Google Flights", ms: 30, ok: false, status: 200, reason: "empty", offers: 0 });

    const scrappa = providerCallStats().find(row => row.provider === "Google Flights");

    expect(scrappa).toMatchObject({ calls: 3, ok: 0, failed: 3 });
    expect(scrappa?.byReason).toEqual({ "402": 1, timeout: 1, empty: 1 });
    expect(scrappa?.worstMs).toBe(20_000);
  });

  it("surfaces the supplier's own reported latency when it sends one", () => {
    recordProviderCall({ provider: "Google Flights", ms: 950, upstreamMs: 1240, ok: true, status: 200, reason: "ok", offers: 5 });
    recordProviderCall({ provider: "Google Flights", ms: 870, upstreamMs: 900, ok: true, status: 200, reason: "ok", offers: 5 });

    const scrappa = providerCallStats().find(row => row.provider === "Google Flights");
    expect(scrappa?.medianUpstreamMs).toBe(1070);
  });

  it("echoes every failure through console.warn so it survives the instance", () => {
    const warnMock = vi.spyOn(console, "warn");
    recordProviderCall({ provider: "Google Flights", ms: 40, ok: false, status: 402, reason: "402", offers: 0 });

    expect(warnMock).toHaveBeenCalledTimes(1);
    const logged = warnMock.mock.calls[0].join(" ");
    expect(logged).toContain("Google Flights");
    expect(logged).toContain("402");
  });

  it("keeps successes quiet - a healthy path must not spam the log", () => {
    recordProviderCall({ provider: "Google Flights", ms: 40, ok: true, status: 200, reason: "ok", offers: 6 });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("bounds the buffer so telemetry can never become the memory leak", () => {
    for (let i = 0; i < 500; i += 1) {
      recordProviderCall({ provider: "Google Flights", ms: i, ok: true, status: 200, reason: "ok", offers: 1 });
    }
    expect(recentProviderCalls(1000).length).toBeLessThanOrEqual(300);
  });

  it("returns no stats before anything has been recorded", () => {
    expect(providerCallStats()).toEqual([]);
    expect(fallThroughStats()).toEqual({ toNextProvider: 0, toSeed: 0, byProvider: {} });
  });
});

describe("fall-through counters (report Q4)", () => {
  it("separates moving to the next supplier from giving up on the chain", () => {
    recordFallThrough("Google Flights", "next-provider", "search");
    recordFallThrough("Ignav", "next-provider", "search");
    recordFallThrough("Ignav", "seed", "search");

    const stats = fallThroughStats();
    expect(stats.toNextProvider).toBe(2);
    expect(stats.toSeed).toBe(1);
    expect(stats.byProvider).toEqual({ "Google Flights": 1, Ignav: 2 });
  });

  it("keeps alert refreshes counted separately from public search", () => {
    recordFallThrough("Google Flights", "seed", "alert");
    expect(fallThroughStats().toSeed).toBe(1);
  });
});

describe("end to end through searchFlights", () => {
  async function fresh() {
    return await import("./flight-data");
  }

  it("records a 402, the fall-through to Ignav, and the fall-through to seed", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", "scrappa-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 402 })));

    const { searchFlights, resetSearchSpendMemo } = await fresh();
    resetSearchSpendMemo();
    resetProviderTelemetry();

    const result = await searchFlights({
      origin: "SFO",
      destination: "NRT",
      departureDate: "2026-12-03",
      passengers: 1,
      tripType: "oneWay",
    });

    // Honest fallback: a failed chain must never be presented as a live fare.
    expect(result.source).not.toBe("live");

    const scrappa = providerCallStats().find(row => row.provider === "Google Flights");
    expect(scrappa).toMatchObject({ calls: 1, ok: 0, failed: 1 });
    expect(scrappa?.byReason).toEqual({ "402": 1 });

    // Scrappa abandoned -> Ignav tried (no key, so no call) -> chain exhausted.
    const falls = fallThroughStats();
    expect(falls.byProvider["Google Flights"]).toBe(1);
    expect(falls.toSeed).toBeGreaterThanOrEqual(1);
  });

  it("records a successful supplier call with its latency", async () => {
    vi.stubEnv("SCRAPPA_API_KEY", "scrappa-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        flights: [{
          price: 500,
          currency: "USD",
          total_duration_minutes: 420,
          stops: 0,
          airline_name: "Delta",
          legs: [{ airline: "DL", departure_time: "2026-12-03T10:00:00", arrival_time: "2026-12-03T18:00:00" }],
        }],
        search_metadata: { response_time_ms: 1240 },
      }),
    })));

    const { searchFlights, resetSearchSpendMemo } = await fresh();
    resetSearchSpendMemo();
    resetProviderTelemetry();

    // Deliberately a DIFFERENT route from the 402 case above: flight-data caches the
    // seed fallback on a failed search, so repeating SFO->NRT would be served from
    // cache and never reach the supplier at all.
    const result = await searchFlights({
      origin: "DEL",
      destination: "LHR",
      departureDate: "2026-12-03",
      passengers: 1,
      tripType: "oneWay",
    });
    expect(result.source).toBe("live");

    const scrappa = providerCallStats().find(row => row.provider === "Google Flights");
    expect(scrappa?.ok).toBe(1);
    expect(scrappa?.medianUpstreamMs).toBe(1240);
    expect(fallThroughStats().toSeed).toBe(0);
  });
});
