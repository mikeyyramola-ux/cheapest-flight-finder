import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * Escalation triggers E16/E17/E18 (see LEARNING_NOTES): the quota board's own
 * warnings, now carried by the daily cron into the record AND into Telegram (owner
 * order, 2026-09-30: "for telegram yes wire that").
 *
 * What is asserted here is the wiring, not the board's arithmetic (that is
 * cloud-quota.test.ts's job) and not the dedup rules (board-escalation.test.ts):
 *
 *  - a row at or over 75% reaches both channels as E17, with the same words;
 *  - a board that cannot be read escalates as E16 instead of reporting a healthy run;
 *  - a warn supplier pool reaches Telegram as E14 using the record's own detail string,
 *    so the JSON and the chat can never disagree about what fired;
 *  - a clean run still PROVES the check happened (`boardAlertCheck.ok`), because an
 *    absent alert is only all-clear when the check is known to have run.
 */

const SECRET = "e17-test-secret";

const { scanMock, quotaMock, collectMock, sendMock } = vi.hoisted(() => ({
  scanMock: vi.fn(),
  quotaMock: vi.fn(),
  collectMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock("./flight-data", async () => {
  const actual = await vi.importActual<typeof import("./flight-data")>("./flight-data");
  return { ...actual, scanTrackedRoutes: () => scanMock() };
});

vi.mock("./quota", async () => {
  const actual = await vi.importActual<typeof import("./quota")>("./quota");
  return { ...actual, loadQuotaStatus: () => quotaMock() };
});

vi.mock("./board-escalation", () => ({
  collectCloudBoardAlerts: (...args: unknown[]) => collectMock(...args),
  sendOwnerAlerts: (...args: unknown[]) => sendMock(...args),
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

type AlertSent = { code: string; entries: number; action: string; delivered: boolean; reason: string };
type Body = {
  ok: boolean;
  escalations: Array<{ level: string; code: string; detail: string }>;
  boardAlertCheck: { ok: boolean; error: string | null };
  ownerAlerts: AlertSent[];
};

const HEALTHY_SCAN = {
  checkedAt: new Date("2026-09-30T12:00:00.000Z").toISOString(),
  routesTotal: 2,
  liveRefreshed: 2,
  liveProviders: 1,
  suppliers: ["scrappa"],
  observationsStored: 2,
  hydrated: true,
  alerts: [],
};

let handler: typeof import("./scheduled").scanFlightDealsHandler;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("CRON_SECRET", SECRET);
  // No storage configured for these runs: E13 stays gated off (it is E13's own rule).
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.stubEnv("TELEGRAM_CHAT_ID", "");
  scanMock.mockResolvedValue(HEALTHY_SCAN);
  quotaMock.mockResolvedValue([]);
  collectMock.mockResolvedValue({ alerts: [], failure: null });
  sendMock.mockResolvedValue([]);
  ({ scanFlightDealsHandler: handler } = await import("./scheduled"));
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  scanMock.mockReset();
  quotaMock.mockReset();
  collectMock.mockReset();
  sendMock.mockReset();
});

describe("quota board alerts in the cron record", () => {
  it("carries an E17 row to the record and to Telegram in the same words", async () => {
    const line =
      "Render / Free instance hours: 82% used (620 of 750 hours, resets monthly) - at or over the 75% line, api reading; act before 100%";
    collectMock.mockResolvedValue({ alerts: [{ code: "E17", key: "render-instance-hours", percent: 82, line }], failure: null });
    sendMock.mockResolvedValue([{ code: "E17", entries: 1, action: "sent", delivered: true, reason: "accepted by Telegram" }]);

    const { res, state } = fakeRes();
    await handler(fakeReq(), res);
    const body = state.body as Body;

    const e17 = body.escalations.find(item => item.code === "E17");
    expect(e17).toBeDefined();
    expect(e17?.level).toBe("owner");
    expect(e17?.detail).toBe(line);

    const sent = sendMock.mock.calls[0]?.[0] as Array<{ code: string; key: string; percent: number; line: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ code: "E17", key: "render-instance-hours", percent: 82, line });
    expect(sendMock.mock.calls[0]?.[1]).toBeInstanceOf(Date);

    expect(body.ownerAlerts).toEqual([
      { code: "E17", entries: 1, action: "sent", delivered: true, reason: "accepted by Telegram" },
    ]);
    expect(body.boardAlertCheck).toEqual({ ok: true, error: null });
  });

  it("escalates an unreadable board as E16 instead of letting the run look healthy", async () => {
    collectMock.mockResolvedValue({ alerts: [], failure: "database unreachable" });
    sendMock.mockResolvedValue([{ code: "E16", entries: 1, action: "sent", delivered: true, reason: "accepted by Telegram" }]);

    const { res, state } = fakeRes();
    await handler(fakeReq(), res);
    const body = state.body as Body;

    const e16 = body.escalations.find(item => item.code === "E16");
    expect(e16).toBeDefined();
    expect(e16?.detail).toContain("database unreachable");
    expect(e16?.detail).toContain("E17/E18 were not evaluated");
    expect(body.boardAlertCheck).toEqual({ ok: false, error: "database unreachable" });
    // Nothing was evaluated, so nothing may be claimed as evaluated.
    expect(body.escalations.some(item => item.code === "E17" || item.code === "E18")).toBe(false);
    const alerted = sendMock.mock.calls[0]?.[0] as Array<{ code: string }>;
    expect(alerted.map(alert => alert.code)).toEqual(["E16"]);
  });

  it("hands a warn supplier pool to Telegram as E14 with the record's own detail", async () => {
    quotaMock.mockResolvedValue([
      {
        key: "scrappa",
        label: "Scrappa",
        used: 420,
        limit: 500,
        percent: 84,
        period: "month",
        warn: true,
        exhausted: false,
        wired: true,
        source: "database",
      },
    ]);
    sendMock.mockResolvedValue([{ code: "E14", entries: 1, action: "sent", delivered: true, reason: "accepted by Telegram" }]);

    const { res, state } = fakeRes();
    await handler(fakeReq(), res);
    const body = state.body as Body;

    const e14 = body.escalations.find(item => item.code === "E14");
    expect(e14).toBeDefined();
    expect(e14?.detail).toContain("Scrappa quota 84% used (420/500, resets month)");

    const alerted = sendMock.mock.calls[0]?.[0] as Array<{ code: string; key: string; percent: number; line: string }>;
    expect(alerted).toHaveLength(1);
    expect(alerted[0]).toMatchObject({ code: "E14", key: "scrappa", percent: 84, line: e14?.detail });
    expect(body.ownerAlerts[0]).toMatchObject({ code: "E14", action: "sent", delivered: true });
  });

  it("proves the check ran even when nothing fired - absence is not all-clear", async () => {
    const { res, state } = fakeRes();
    await handler(fakeReq(), res);
    const body = state.body as Body;

    expect(Array.isArray(body.escalations)).toBe(true);
    expect(body.escalations.some(item => ["E16", "E17", "E18"].includes(item.code))).toBe(false);
    expect(body.boardAlertCheck).toEqual({ ok: true, error: null });
    expect(body.ownerAlerts).toEqual([]);
    // The check is always run, and always recorded, including for the codes that had
    // nothing to say (their dedup state is what lets a recurrence be news).
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toEqual([]);
  });
});
