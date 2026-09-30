import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * Escalation trigger E13 (see LEARNING_NOTES): live fares were priced, but nothing
 * reached the price-history table.
 *
 * The history table is the asset this product is eventually paid for, so a run that
 * captures real prices and stores none of them has to read as a failure. Without this
 * trigger the cron would report `ok: true` while the dataset silently stopped growing -
 * and a dataset that stopped growing looks exactly like one that is merely quiet.
 */

const SECRET = "e13-test-secret";

// Declared with vi.hoisted because the vi.mock factory is hoisted above normal
// top-level statements and cannot otherwise see this reference.
const { scanMock } = vi.hoisted(() => ({ scanMock: vi.fn() }));

vi.mock("./flight-data", async () => {
  const actual = await vi.importActual<typeof import("./flight-data")>("./flight-data");
  return { ...actual, scanTrackedRoutes: () => scanMock() };
});

// The cron now reads the quota board for E16/E17/E18, which would otherwise pull live
// Render/Vercel endpoints and the observation store into this suite - a test run must
// never write production state. Mocked to "nothing fired"; the board's own alerts are
// covered in escalation.e17.test.ts.
vi.mock("./board-escalation", () => ({
  collectCloudBoardAlerts: vi.fn(async () => ({ alerts: [], failure: null })),
  sendOwnerAlerts: vi.fn(async () => []),
}));

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

type Body = {
  ok: boolean;
  routesLivePriced: number;
  historyPointsStored: number;
  escalations: Array<{ level: string; code: string; detail: string }>;
};

/** A run where suppliers answered but storage recorded nothing - the failure E13 exists for. */
function scanWhereNothingWasStored() {
  return {
    checkedAt: new Date().toISOString(),
    routesTotal: 2,
    liveRefreshed: 2,
    liveProviders: 1,
    observationsStored: 0,
    hydrated: true,
    alerts: [],
  };
}

let handler: typeof import("./scheduled").scanFlightDealsHandler;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("CRON_SECRET", SECRET);
  scanMock.mockResolvedValue(scanWhereNothingWasStored());
  ({ scanFlightDealsHandler: handler } = await import("./scheduled"));
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  scanMock.mockReset();
});

describe("E13 - history not accruing", () => {
  it("escalates when fares were priced live but zero history points were stored", async () => {
    vi.stubEnv("DATABASE_URL", "mysql://example.invalid/fareloop");
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    expect(body.ok).toBe(true);
    expect(body.routesLivePriced).toBeGreaterThan(0);
    expect(body.historyPointsStored).toBe(0);

    const e13 = body.escalations.find(item => item.code === "E13");
    expect(e13).toBeDefined();
    expect(e13?.level).toBe("owner");
    expect(e13?.detail).toMatch(/0 history points stored/);
  });

  it("does not cry wolf when no storage is configured, and still always returns the list", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    expect(Array.isArray(body.escalations)).toBe(true);
    expect(body.escalations.find(item => item.code === "E13")).toBeUndefined();
  });

  it("stays quiet when every priced route was actually stored", async () => {
    vi.stubEnv("DATABASE_URL", "mysql://example.invalid/fareloop");
    scanMock.mockResolvedValue({ ...scanWhereNothingWasStored(), observationsStored: 2 });
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as Body;
    expect(body.historyPointsStored).toBe(2);
    expect(body.escalations.find(item => item.code === "E13")).toBeUndefined();
  });
});
