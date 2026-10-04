import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildQuotaStatus } from "./quota";

/**
 * E14 used to only WARN at 75%, so the last quarter of the shared Scrappa pool stayed
 * spendable by anonymous search - the escalation fired and the pool drained anyway.
 * PROPOSAL 19 closes that gap: past 75% public search stops spending and falls through
 * to the honestly-labelled sample path, while tracked-route refreshes (purpose "alert")
 * keep going.
 *
 * The observable is `fetch`: if the supplier chain is reached, fetch is called. If the
 * breaker cut it out, fetch is never touched. The threshold is DERIVED from the
 * configured limit rather than hardcoded, so the suite stays correct when the pool
 * moves from 500 to 33,500 (PROPOSAL 20).
 */

const quotaMock = vi.hoisted(() => vi.fn());

vi.mock("./quota", async () => {
  const actual = await vi.importActual<typeof import("./quota")>("./quota");
  return { ...actual, loadQuotaStatus: () => quotaMock() };
});

const KEY = "scrappa-test-key";

const scrappaReply = () => ({
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
  }),
});

/** Smallest `used` that trips warn, and the largest that does not. */
function thresholds() {
  const limit = buildQuotaStatus({ scrappa: 0 }, "database")[0].limit;
  const atWarn = Math.ceil((limit * 75) / 100);
  return { justBelow: atWarn - 1, atWarn, limit };
}

const searchInput = {
  origin: "SFO",
  destination: "NRT",
  departureDate: "2026-12-03",
  passengers: 1,
  tripType: "oneWay" as const,
};

/** Fresh module per test: the breaker memo and the live cache are module state. */
async function fresh() {
  return await import("./flight-data");
}

beforeEach(() => {
  vi.resetModules();
  quotaMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("E14 circuit-breaker (PROPOSAL 19)", () => {
  it("still funds public search just below 75%", async () => {
    const { justBelow } = thresholds();
    quotaMock.mockResolvedValue(buildQuotaStatus({ scrappa: justBelow }, "database"));
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    const fetchMock = vi.fn(async () => scrappaReply());
    vi.stubGlobal("fetch", fetchMock);

    const { searchFlights, resetSearchSpendMemo } = await fresh();
    resetSearchSpendMemo();
    const result = await searchFlights(searchInput);

    expect(result.source).toBe("live");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("stops public search at exactly 75%", async () => {
    const { atWarn } = thresholds();
    quotaMock.mockResolvedValue(buildQuotaStatus({ scrappa: atWarn }, "database"));
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    const fetchMock = vi.fn(async () => scrappaReply());
    vi.stubGlobal("fetch", fetchMock);

    const { searchFlights, resetSearchSpendMemo } = await fresh();
    resetSearchSpendMemo();
    const result = await searchFlights(searchInput);

    expect(result.source).not.toBe("live");
    expect(result.offers.every(offer => offer.source !== "Live fare")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps tracked-route refreshes (purpose alert) alive at 75%", async () => {
    const { atWarn } = thresholds();
    quotaMock.mockResolvedValue(buildQuotaStatus({ scrappa: atWarn }, "database"));
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    const fetchMock = vi.fn(async () => scrappaReply());
    vi.stubGlobal("fetch", fetchMock);

    const { searchFlights, resetSearchSpendMemo } = await fresh();
    resetSearchSpendMemo();
    const result = await searchFlights(searchInput, "alert");

    expect(result.source).toBe("live");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("still serves an already-cached live answer while blocked", async () => {
    const { justBelow, atWarn } = thresholds();
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    const fetchMock = vi.fn(async () => scrappaReply());
    vi.stubGlobal("fetch", fetchMock);

    const { searchFlights, resetSearchSpendMemo } = await fresh();
    resetSearchSpendMemo();

    // Paid for and cached while the pool was still healthy.
    quotaMock.mockResolvedValue(buildQuotaStatus({ scrappa: justBelow }, "database"));
    const warm = await searchFlights(searchInput);
    expect(warm.source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Pool crosses 75%; the cached answer must still be free to serve.
    quotaMock.mockResolvedValue(buildQuotaStatus({ scrappa: atWarn }, "database"));
    resetSearchSpendMemo();
    const served = await searchFlights(searchInput);

    expect(served.cached).toBe(true);
    expect(served.source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second supplier call
  });

  it("does not block when the quota ledger is unreachable", async () => {
    quotaMock.mockRejectedValue(new Error("db down"));
    vi.stubEnv("SCRAPPA_API_KEY", KEY);
    const fetchMock = vi.fn(async () => scrappaReply());
    vi.stubGlobal("fetch", fetchMock);

    const { searchFlights, resetSearchSpendMemo } = await fresh();
    resetSearchSpendMemo();
    const result = await searchFlights(searchInput);

    expect(result.source).toBe("live");
    expect(fetchMock).toHaveBeenCalled();
  });
});
