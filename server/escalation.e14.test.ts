import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * Escalation trigger E14 (see LEARNING_NOTES): a supplier's free allowance is 75%
 * spent, while a quarter of the pool is still left to act on.
 *
 * Not one supplier exposes a usage endpoint, so the ledger we keep at charge time is
 * the only warning that exists. The threshold is deliberately 75% and not 100%: at
 * 100% the next subscriber alert simply does not go out, which is the failure this
 * whole system exists to prevent. E3 remains the tripwire for an empty pool; E14 is
 * what makes E3 avoidable.
 *
 * Every tracked supplier is reported - Scrappa, Ignav and Bright Data - so a reserve
 * draining quietly in the background is as visible as the primary pool running low.
 */

const SECRET = "e14-test-secret";

const { scanMock, quotaMock } = vi.hoisted(() => ({
  scanMock: vi.fn(),
  quotaMock: vi.fn(),
}));

vi.mock("./flight-data", async () => {
  const actual = await vi.importActual<typeof import("./flight-data")>("./flight-data");
  return { ...actual, scanTrackedRoutes: () => scanMock() };
});

vi.mock("./quota", async () => {
  const actual = await vi.importActual<typeof import("./quota")>("./quota");
  return { ...actual, loadQuotaStatus: () => quotaMock() };
});

function fakeReq() {
  return { get: () => `Bearer ${SECRET}` } as unknown as Request;
}

function fakeRes() {
  const state: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      state.body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

type QuotaRow = {
  key: string;
  label: string;
  used: number;
  limit: number;
  percent: number;
  period: string;
  warn: boolean;
  exhausted: boolean;
  wired: boolean;
  source: string;
};

type Body = {
  ok: boolean;
  quotas: QuotaRow[];
  quotaWarnPercent: number;
  escalations: Array<{ level: string; code: string; detail: string }>;
};

const healthyScan = () => ({
  checkedAt: new Date().toISOString(),
  routesTotal: 4,
  liveRefreshed: 4,
  liveProviders: 1,
  observationsStored: 4,
  hydrated: true,
  alerts: [],
});

/** A supplier sitting exactly on the E14 boundary: 375 of 500. */
const scrappaAtWarn = (): QuotaRow[] => [
  { key: "scrappa", label: "Scrappa (Google Flights)", used: 375, limit: 500, percent: 75, period: "2026-09", warn: true, exhausted: false, wired: true, source: "database" },
  { key: "ignav", label: "Ignav", used: 12, limit: 1000, percent: 1, period: "lifetime", warn: false, exhausted: false, wired: true, source: "database" },
  { key: "brightdata", label: "Bright Data", used: 0, limit: 5000, percent: 0, period: "2026-09", warn: false, exhausted: false, wired: false, source: "database" },
];

/** One credit under the threshold: 374 of 500. */
const scrappaJustBelow = (): QuotaRow[] =>
  scrappaAtWarn().map(quota => (quota.key === "scrappa" ? { ...quota, used: 374, percent: 74, warn: false } : quota));

let handler: typeof import("./scheduled").scanFlightDealsHandler;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("CRON_SECRET", SECRET);
  scanMock.mockResolvedValue(healthyScan());
  quotaMock.mockResolvedValue(scrappaAtWarn());
  ({ scanFlightDealsHandler: handler } = await import("./scheduled"));
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  scanMock.mockReset();
  quotaMock.mockReset();
});

describe("E14 - supplier quota at 75%", () => {
  it("flags the owner when any supplier reaches 75% of its allowance", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    expect(body.ok).toBe(true);
    expect(body.quotaWarnPercent).toBe(75);

    const e14 = body.escalations.find(item => item.code === "E14");
    expect(e14).toBeDefined();
    expect(e14?.level).toBe("owner");
    expect(e14?.detail).toContain("Scrappa (Google Flights)");
    expect(e14?.detail).toContain("375/500");
  });

  it("stays quiet one credit below the threshold", async () => {
    quotaMock.mockResolvedValue(scrappaJustBelow());
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    expect(body.escalations.find(item => item.code === "E14")).toBeUndefined();
    expect(body.quotas.find(quota => quota.key === "scrappa")?.percent).toBe(74);
  });

  it("reports every tracked supplier on every run, including the unwired reserve", async () => {
    quotaMock.mockResolvedValue(scrappaJustBelow());
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    expect(body.quotas.map(quota => quota.key)).toEqual(["scrappa", "ignav", "brightdata"]);
    // Bright Data is not in the live chain, and the report says so rather than
    // presenting it as an available pool.
    expect(body.quotas.find(quota => quota.key === "brightdata")?.wired).toBe(false);
    // A one-time allowance must read as one-time, or "it resets" is implied falsely.
    expect(body.quotas.find(quota => quota.key === "ignav")?.period).toBe("lifetime");
  });

  it("escalates a one-time allowance that is nearly gone, and says it does not refill", async () => {
    quotaMock.mockResolvedValue([
      { key: "scrappa", label: "Scrappa (Google Flights)", used: 10, limit: 500, percent: 2, period: "2026-09", warn: false, exhausted: false, wired: true, source: "database" },
      { key: "ignav", label: "Ignav", used: 900, limit: 1000, percent: 90, period: "lifetime", warn: true, exhausted: false, wired: true, source: "database" },
      { key: "brightdata", label: "Bright Data", used: 0, limit: 5000, percent: 0, period: "2026-09", warn: false, exhausted: false, wired: false, source: "database" },
    ]);
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    const e14 = body.escalations.find(item => item.code === "E14");
    expect(e14?.detail).toContain("Ignav");
    expect(e14?.detail).toContain("900/1000");
    expect(e14?.detail).toMatch(/does not refill/);
  });

  it("marks an empty pool as EXHAUSTED rather than merely a percentage", async () => {
    quotaMock.mockResolvedValue(
      scrappaAtWarn().map(quota => (quota.key === "scrappa" ? { ...quota, used: 500, percent: 100, warn: true, exhausted: true } : quota)),
    );
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    const e14 = body.escalations.find(item => item.code === "E14");
    expect(e14?.detail).toContain("EXHAUSTED");
  });

  it("says the number is an instance view when storage is unreachable", async () => {
    quotaMock.mockResolvedValue(scrappaAtWarn().map(quota => ({ ...quota, source: "instance-memory" })));
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    const e14 = body.escalations.find(item => item.code === "E14");
    expect(e14?.detail).toMatch(/instance view only/);
  });
});
