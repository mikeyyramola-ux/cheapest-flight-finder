import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Render's hour counter is reconstructed, not read - so two things have to be proven
 * before it may stand on the board:
 *
 *  - the integration counts only awake time. A gap wider than one scrape run is
 *    downtime (spun-down services consume no hours, render.com/docs/free) and must
 *    contribute nothing; a timestamp that will not parse must contribute nothing
 *    either, because both would silently inflate a ceiling.
 *  - the plan refuses a month it cannot measure completely. Render retains 7 days of
 *    free-plan metrics, so a month older than that with no checkpoint is unmeasurable
 *    - and an unmeasurable month reported as a partial number is the quiet undercount
 *    that lets the 750-hour suspension arrive unannounced.
 */

const { readMock, saveMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  saveMock: vi.fn(),
}));

// The observation store is a database table; no test opens a database connection.
vi.mock("./observations", () => ({
  readBoardObservation: () => readMock(),
  saveBoardObservation: (...args: unknown[]) => saveMock(...args),
}));

import {
  integrateAwakeSeconds,
  measureRenderInstanceHours,
  planRenderHours,
  persistRenderCheckpoint,
  utcMonthStart,
  utcPeriodKey,
} from "./render-usage";

const AT = Date.parse("2026-09-30T12:00:00Z");
const BIRTH = Date.parse("2026-09-24T19:20:08.460654Z");
const RETENTION = 6.5 * 24 * 60 * 60 * 1000;

function sample(iso: string) {
  return { timestamp: iso, value: 0.001 };
}

describe("awake time is integrated from CPU samples, never from wall clock", () => {
  it("sums the intervals between consecutive samples of one instance", () => {
    const seconds = integrateAwakeSeconds([
      { values: [sample("2026-09-30T10:00:00Z"), sample("2026-09-30T10:05:00Z"), sample("2026-09-30T10:10:00Z")] },
    ]);
    expect(seconds).toBe(600);
  });

  it("adds across instance lifetimes (each spin-up is its own series)", () => {
    const seconds = integrateAwakeSeconds([
      { values: [sample("2026-09-30T10:00:00Z"), sample("2026-09-30T10:05:00Z")] },
      { values: [sample("2026-09-30T11:00:00Z"), sample("2026-09-30T11:05:00Z")] },
    ]);
    expect(seconds).toBe(600);
  });

  it("treats a gap beyond the scrape cap as downtime and skips it", () => {
    // 30 minutes of silence is a spin-down (or lost scrapes), not awake time: Render
    // explicitly does not bill spun-down services.
    const seconds = integrateAwakeSeconds([
      { values: [sample("2026-09-30T10:00:00Z"), sample("2026-09-30T10:30:00Z"), sample("2026-09-30T10:35:00Z")] },
    ]);
    expect(seconds).toBe(300);
  });

  it("keeps a one-missed-scrape gap, which is still awake time", () => {
    const seconds = integrateAwakeSeconds([
      { values: [sample("2026-09-30T10:00:00Z"), sample("2026-09-30T10:10:00Z")] },
    ]);
    expect(seconds).toBe(600);
  });

  it("ignores timestamps that will not parse rather than assuming them", () => {
    const seconds = integrateAwakeSeconds([
      { values: [{ timestamp: "not a date" }, sample("2026-09-30T10:00:00Z"), sample("2026-09-30T10:05:00Z")] },
    ]);
    expect(seconds).toBe(300);
  });

  it("counts nothing for empty or malformed series", () => {
    expect(integrateAwakeSeconds([])).toBe(0);
    expect(integrateAwakeSeconds([{ values: null }, { values: [] }, {} as never])).toBe(0);
  });
});

describe("the plan refuses months it cannot measure completely", () => {
  const deps = (over: Partial<Record<"monthStartMs" | "retentionFloorMs" | "birthMs" | "periodKey", number | string>> = {}) => ({
    monthStartMs: (over.monthStartMs as number) ?? utcMonthStart(AT),
    retentionFloorMs: (over.retentionFloorMs as number) ?? AT - RETENTION,
    birthMs: (over.birthMs as number) ?? BIRTH,
    periodKey: (over.periodKey as string) ?? utcPeriodKey(AT),
  });

  it("continues from a same-month checkpoint inside the retention window", () => {
    const plan = planRenderHours(AT, { metricKey: "render-instance-hours", periodKey: "2026-09", used: 332100, observedAtUnix: Math.floor(Date.parse("2026-09-30T11:00:00Z") / 1000), detail: "d" }, deps());
    expect(plan).toEqual({ fromMs: Date.parse("2026-09-30T11:00:00Z"), accumulatedSeconds: 332100 });
  });

  it("blocks when the checkpoint itself predates the 7-day retention window", () => {
    const plan = planRenderHours(AT, { metricKey: "render-instance-hours", periodKey: "2026-09", used: 1000, observedAtUnix: Math.floor((AT - 8 * 24 * 60 * 60 * 1000) / 1000), detail: "d" }, deps());
    expect(plan).toHaveProperty("blocked");
    expect((plan as { blocked: string }).blocked).toMatch(/retention/);
  });

  it("measures a month that began inside the retention window directly", () => {
    const plan = planRenderHours(AT, null, deps({ monthStartMs: Date.parse("2026-09-28T00:00:00Z") }));
    expect(plan).toEqual({ fromMs: Date.parse("2026-09-28T00:00:00Z"), accumulatedSeconds: 0 });
  });

  it("starts from the service's birth when the pre-retention prefix is provably zero", () => {
    // The month began before retention, but the service did not exist until inside
    // it - so hours before the birth are zero, not unknown, and the month is complete.
    const plan = planRenderHours(AT, null, deps({ monthStartMs: Date.parse("2026-09-01T00:00:00Z") }));
    expect(plan).toEqual({ fromMs: BIRTH, accumulatedSeconds: 0 });
  });

  it("blocks a pre-retention month whose prefix is genuinely unknown", () => {
    // A later month with no checkpoint: hours before the retention floor cannot be
    // recovered, and the service predates the month, so nothing proves the prefix 0.
    const plan = planRenderHours(Date.parse("2026-11-15T12:00:00Z"), null, {
      monthStartMs: Date.parse("2026-11-01T00:00:00Z"),
      retentionFloorMs: Date.parse("2026-11-08T21:00:00Z"),
      birthMs: BIRTH,
      periodKey: "2026-11",
    });
    expect(plan).toHaveProperty("blocked");
    expect((plan as { blocked: string }).blocked).toMatch(/withheld rather than undercounted/);
  });

  it("ignores a checkpoint left over from a previous month", () => {
    const plan = planRenderHours(AT, { metricKey: "render-instance-hours", periodKey: "2026-08", used: 999999, observedAtUnix: Math.floor(AT / 1000), detail: "d" }, deps());
    // Falls through to the fresh-month logic - last month's total must never be
    // carried into this month's reading.
    expect(plan).toEqual({ fromMs: BIRTH, accumulatedSeconds: 0 });
  });
});

describe("the reading", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    readMock.mockReset();
    saveMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("RENDER_API_KEY", "rk_test");
    readMock.mockResolvedValue({ observation: null, reason: "no observation recorded yet for this metric" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("withholds the hours when no API key is configured, without calling Render", async () => {
    vi.stubEnv("RENDER_API_KEY", "");
    const reading = await measureRenderInstanceHours(new Date(AT));
    expect(reading.used).toBeNull();
    expect(reading.reason).toMatch(/RENDER_API_KEY/);
    expect(reading.checkpoint).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("integrates the month from Render's own metrics and returns a checkpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { values: [sample("2026-09-30T10:00:00Z"), sample("2026-09-30T10:05:00Z"), sample("2026-09-30T10:10:00Z")] },
      ],
    });
    const reading = await measureRenderInstanceHours(new Date(AT));
    expect(reading.used).toBe(0.17);
    expect(reading.reason).toBeNull();
    expect(reading.checkpoint).toMatchObject({ metricKey: "render-instance-hours", periodKey: "2026-09", used: 600 });
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/resource=srv-daqnfpuk1f9s73cps26g/);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/resolutionSeconds=300/);
  });

  it("adds the stored checkpoint so retention cannot drop earlier hours", async () => {
    readMock.mockResolvedValue({
      observation: { metricKey: "render-instance-hours", periodKey: "2026-09", used: 332100, observedAtUnix: Math.floor(Date.parse("2026-09-30T11:00:00Z") / 1000), detail: "d" },
      reason: null,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ values: [sample("2026-09-30T11:00:00Z"), sample("2026-09-30T11:05:00Z")] }],
    });
    const reading = await measureRenderInstanceHours(new Date(AT));
    expect(reading.used).toBe(92.33); // (332100 + 300) s
    expect(reading.checkpoint?.used).toBe(332400);
  });

  it("reports a rejected API call as no number, never a zero", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const reading = await measureRenderInstanceHours(new Date(AT));
    expect(reading.used).toBeNull();
    expect(reading.reason).toMatch(/withheld, never assumed/);
    expect(reading.checkpoint).toBeNull();
  });

  it("does not call Render at all when the month cannot be measured completely", async () => {
    const later = new Date(Date.parse("2026-11-15T12:00:00Z"));
    const reading = await measureRenderInstanceHours(later);
    expect(reading.used).toBeNull();
    expect(reading.reason).toMatch(/withheld rather than undercounted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists a checkpoint only when a successful read produced one", async () => {
    const good = { used: 1.5, reason: null, checkpoint: { metricKey: "render-instance-hours", periodKey: "2026-09", used: 5400, observedAtUnix: 1, detail: "d" } };
    await persistRenderCheckpoint(good);
    expect(saveMock).toHaveBeenCalledWith(good.checkpoint);
    await persistRenderCheckpoint({ used: null, reason: "x", checkpoint: null });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });
});
