import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildQuotaStatus, scrappaCombined } from "./quota";

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
  // PROPOSAL 20: the threshold is 75% of BOTH Scrappa pools, so it is derived from
  // the same combined figure the breaker reads. Before CONFIRM 20 that is 500 and
  // this behaves exactly as it always did; the moment the pack is activated it
  // becomes 33,500 and the assertions follow automatically instead of silently
  // pinning a 375-credit ceiling that no longer decides anything.
  const limit = scrappaCombined(buildQuotaStatus({ scrappa: 0, "scrappa-pack": 0 }, "database")).limit;
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

  it("judges both Scrappa pools as one balance (PROPOSAL 20)", async () => {
    const { searchFlights, resetSearchSpendMemo } = await fresh();
    // Import AFTER fresh() so this is the same quota module instance flight-data
    // holds: vi.mock spreads the actual namespace, so SCRAPPA_PACK is shared by
    // reference and mutating it here changes what buildQuotaStatus reports to it.
    const quota = await import("./quota");
    const original = { ...quota.SCRAPPA_PACK };
    quota.SCRAPPA_PACK.limit = 33_000;
    quota.SCRAPPA_PACK.issuedAt = "2026-10-05";

    try {
      // The free pool on its own is spent out, so its row says 100% and warns.
      // The pack is untouched: the combined balance is 500 of 33,500 - 1.5%, nowhere
      // near 75%. If the breaker still read the free row alone it would block here;
      // reading the total is the whole point of this proposal.
      quotaMock.mockResolvedValue(
        quota.buildQuotaStatus({ scrappa: 500, "scrappa-pack": 0 }, "database"),
      );
      vi.stubEnv("SCRAPPA_API_KEY", KEY);
      const fetchMock = vi.fn(async () => scrappaReply());
      vi.stubGlobal("fetch", fetchMock);

      resetSearchSpendMemo();
      const result = await searchFlights(searchInput);

      expect(result.source).toBe("live");
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      // Restore what was there, not a hardcoded 0/"": CONFIRM 20 made those the wrong
      // values, and a restore that silently unpurchases the pack would poison any
      // later assertion in this same module instance.
      Object.assign(quota.SCRAPPA_PACK, original);
    }
  });

  it("still blocks at 75% of the combined total once the pack is bought", async () => {
    const { searchFlights, resetSearchSpendMemo } = await fresh();
    const quota = await import("./quota");
    const original = { ...quota.SCRAPPA_PACK };
    quota.SCRAPPA_PACK.limit = 33_000;
    quota.SCRAPPA_PACK.issuedAt = "2026-10-05";

    try {
      // 25,125 of 33,500 is exactly 75%: public search must stop.
      quotaMock.mockResolvedValue(
        quota.buildQuotaStatus({ scrappa: 500, "scrappa-pack": 24_625 }, "database"),
      );
      vi.stubEnv("SCRAPPA_API_KEY", KEY);
      const fetchMock = vi.fn(async () => scrappaReply());
      vi.stubGlobal("fetch", fetchMock);

      resetSearchSpendMemo();
      const result = await searchFlights(searchInput);

      expect(result.source).not.toBe("live");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      // Restore what was there, not a hardcoded 0/"": CONFIRM 20 made those the wrong
      // values, and a restore that silently unpurchases the pack would poison any
      // later assertion in this same module instance.
      Object.assign(quota.SCRAPPA_PACK, original);
    }
  });
});
