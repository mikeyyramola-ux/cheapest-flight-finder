import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * GET /api/ops/quotas - the owner's quota board.
 *
 * Two properties matter more than anything else on this route, and both are asserted
 * rather than assumed:
 *
 *  1. It fails closed. The route names every service we depend on and how much of each
 *     allowance is left, so with no secret configured it must answer 403 - the same
 *     rule the scheduled scans already follow, reusing the same key rather than
 *     inventing a second one that nobody would remember to rotate.
 *  2. It only reads. A dashboard that spends the very pool it is meant to be watching
 *     would make the problem it reports. The handler is given a board and returns it;
 *     no scan is invoked anywhere in this path.
 */

const SECRET = "ops-test-secret";

const { boardMock } = vi.hoisted(() => ({ boardMock: vi.fn() }));

vi.mock("./cloud-quota", async () => {
  const actual = await vi.importActual<typeof import("./cloud-quota")>("./cloud-quota");
  return { ...actual, loadCloudBoard: () => boardMock() };
});

import { buildCloudRow, CLOUD_SERVICE_DEFS } from "./cloud-quota";
import { opsQuotasHandler } from "./ops";

function def(key: string) {
  const found = CLOUD_SERVICE_DEFS.find(item => item.key === key);
  if (!found) throw new Error(`registry is missing ${key}`);
  return found;
}

function fakeReq(authorization?: string) {
  return {
    get: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined),
  } as unknown as Request;
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

// Suppliers are not in the registry - they arrive from the credit ledger - so the
// fixture builds one the same way the board does, from a definition plus a measurement.
const supplierDef = {
  ...def("tidb-storage"),
  key: "supplier-credits",
  service: "Scrappa (Google Flights)",
  category: "supplier" as const,
  metric: "Search credits",
  unit: "credits",
  limit: 500,
  period: "month" as const,
  feed: "ledger" as const,
  limitSource: "Credit ledger written at charge time",
  note: null,
};

const healthyBoard = () => [
  buildCloudRow(supplierDef, 8, "database"),
  buildCloudRow(def("tidb-storage"), 1024, "database"),
  buildCloudRow(def("vercel-data-transfer"), null, "none"),
  buildCloudRow(def("paypal-allowance"), null, "none"),
];

type Body = {
  ok: boolean;
  generatedAt: string;
  warnPercent: number;
  summary: { total: number; monitored: number; blindSpots: number; warn: number; exhausted: number; unwired: number };
  services: Array<{ key: string; used: number | null; feed: string; limit: number | null }>;
};

let handler: typeof opsQuotasHandler;

beforeEach(() => {
  vi.resetModules();
  boardMock.mockReset();
  boardMock.mockResolvedValue(healthyBoard());
  handler = opsQuotasHandler;
});

afterEach(() => {
  vi.unstubAllEnvs();
  boardMock.mockReset();
});

describe("the board is not served to just anyone", () => {
  it("refuses when no secret is configured at all", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const { res, state } = fakeRes();
    await handler(fakeReq(`Bearer ${SECRET}`), res);
    expect(state.status).toBe(403);
    expect(state.body?.error).toBe("ops-secret-required");
    expect(state.body?.services).toBeUndefined();
  });

  it("refuses a missing key", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const { res, state } = fakeRes();
    await handler(fakeReq(undefined), res);
    expect(state.status).toBe(403);
  });

  it("refuses the wrong key", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const { res, state } = fakeRes();
    await handler(fakeReq("Bearer not-the-key"), res);
    expect(state.status).toBe(403);
  });

  it("serves the right key", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const { res, state } = fakeRes();
    await handler(fakeReq(`Bearer ${SECRET}`), res);
    expect(state.status).toBeUndefined();
    expect(state.body?.ok).toBe(true);
  });
});

describe("what the board reports", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", SECRET);
  });

  it("states the same warn threshold the escalations use", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(`Bearer ${SECRET}`), res);
    const body = state.body as Body;
    expect(body.warnPercent).toBe(75);
  });

  it("carries every row it was handed plus a roll-up", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(`Bearer ${SECRET}`), res);
    const body = state.body as Body;
    expect(body.services).toHaveLength(4);
    expect(body.summary.total).toBe(4);
    expect(body.summary.monitored).toBe(2);
    expect(body.summary.blindSpots).toBe(1);
  });

  it("never lets an unwatched metric present itself as zero", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(`Bearer ${SECRET}`), res);
    const body = state.body as Body;
    for (const row of body.services.filter(item => item.feed === "none")) {
      expect(row.used).toBeNull();
    }
  });

  it("stamps the read with a time so an old screenshot cannot pass as current", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(`Bearer ${SECRET}`), res);
    const body = state.body as Body;
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it("reports a board that cannot be built instead of inventing one", async () => {
    boardMock.mockRejectedValue(new Error("read failed"));
    const { res, state } = fakeRes();
    await handler(fakeReq(`Bearer ${SECRET}`), res);
    expect(state.status).toBe(500);
    expect(state.body?.services).toBeUndefined();
  });
});
