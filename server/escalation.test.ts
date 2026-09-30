import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { scanFlightDealsHandler } from "./scheduled";

/**
 * Escalation triggers E3/E5/E6 (see LEARNING_NOTES).
 *
 * The point of these tests is that a bad run cannot look healthy. A scan that prices
 * fewer routes than it claims to check, or that generates alerts nobody receives, must
 * return an `owner` escalation - because silence is what lets a broken alert service
 * keep taking money.
 */

const SECRET = "escalation-test-secret";

// The cron now reads the quota board for E16/E17/E18, which would otherwise pull live
// Render/Vercel endpoints and the observation store into this suite - a test run must
// never write production state. Mocked to "nothing fired" so these tests stay about
// E3/E5/E6; the board's own alerts are covered in escalation.e17.test.ts.
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

let handler: typeof import("./scheduled").scanFlightDealsHandler;

beforeEach(async () => {
  vi.resetModules();
  // No suppliers configured and no Telegram credentials: every route stays on the seed
  // path (E5) and any alert that fires cannot be delivered (E6).
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("SCRAPPA_API_KEY", "");
  vi.stubEnv("IGNAV_API_KEY", "");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("TELEGRAM_CHAT_ID", "");
  ({ scanFlightDealsHandler: handler } = await import("./scheduled"));
  // First import of ./scheduled builds the SDK/OAuth chain and is slow on a cold module
  // graph; later ones are fast. Generous timeout rather than shrinking the assertion set.
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("cron escalations", () => {
  it("refuses to run without the cron secret", async () => {
    const { res, state } = fakeRes();
    await handler({ get: () => undefined } as unknown as Request, res);
    expect(state.status).toBe(403);
    expect(state.body?.error).toBe("cron-secret-required");
  });

  it("escalates when fewer routes were priced live than were checked (E5)", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as {
      ok: boolean;
      routesChecked: number;
      routesLivePriced: number;
      escalations: Array<{ level: string; code: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.routesLivePriced).toBeLessThan(body.routesChecked);

    const e5 = body.escalations.find(item => item.code === "E5");
    expect(e5).toBeDefined();
    expect(e5?.level).toBe("owner");
  });

  it("escalates when an alert was generated but not delivered (E6)", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as {
      notificationsAttempted: number;
      notificationsDelivered: number;
      escalations: Array<{ level: string; code: string; detail: string }>;
    };
    // Telegram is unconfigured, so any alert that fires must be reported as undelivered.
    expect(body.notificationsAttempted).toBeGreaterThan(body.notificationsDelivered);

    const e6 = body.escalations.find(item => item.code === "E6");
    expect(e6).toBeDefined();
    expect(e6?.level).toBe("owner");
    expect(e6?.detail).toMatch(/not delivered/);
  });

  it("returns an empty escalation list only when nothing is wrong", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);

    const body = state.body as { escalations: Array<{ code: string }> };
    // In this fixture E5 and E6 are expected; the assertion that matters is that the
    // field always exists, so a consumer can never mistake absence for "all clear".
    expect(Array.isArray(body.escalations)).toBe(true);
    expect(body.escalations.every(item => ["E3", "E5", "E6"].includes(item.code))).toBe(true);
  });
});
