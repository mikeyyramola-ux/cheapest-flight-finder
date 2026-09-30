import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The quota board is an ops instrument: if it is wrong, the wrong thing gets acted on.
 *
 * Two failure modes are guarded here because both would be invisible on a dashboard:
 *
 *  - a ceiling nobody can trace. Any limit in this file has to carry the document it
 *    came from, so a number cannot quietly become folklore.
 *  - an unwatched metric rendered as zero. `used: 0` reads as "nothing has been spent",
 *    which is a claim we cannot make about a counter we do not keep. It has to come
 *    back as null, and the row has to say there is no feed.
 *
 * The threshold maths is asserted exactly (375 of 500 warns, 374 does not) for the same
 * reason E14 asserts it: a dashboard that rounds its way to a different answer than the
 * escalation it is supposed to preview would be worse than no dashboard.
 */

const { quotaMock, probeMock, usageMock, renderHoursMock, obsMock, persistMock } = vi.hoisted(() => ({
  quotaMock: vi.fn(),
  probeMock: vi.fn(),
  usageMock: vi.fn(),
  renderHoursMock: vi.fn(),
  obsMock: vi.fn(),
  persistMock: vi.fn(),
}));

vi.mock("./quota", async () => {
  const actual = await vi.importActual<typeof import("./quota")>("./quota");
  return { ...actual, loadQuotaStatus: () => quotaMock() };
});

// The Render probe is a live HTTP call to the primary engine: no test may open one,
// for the same reason no test opens a database connection. Its answer is asserted
// through this mock, exactly like the ledger's.
vi.mock("./render-probe", () => ({ probeRenderEngine: () => probeMock() }));

// Vercel's deployments API is the same deal - a live provider call - so the count is
// asserted through this mock rather than by reaching the network.
vi.mock("./vercel-usage", () => ({ measureVercelDeployments: () => usageMock() }));

// Render's metrics API likewise: the hours row and its checkpoint persistence are
// asserted through these mocks rather than by reaching the network.
vi.mock("./render-usage", () => ({
  measureRenderInstanceHours: () => renderHoursMock(),
  persistRenderCheckpoint: (...args: unknown[]) => persistMock(...args),
}));

// The console observation store is a database table; its freshness rule has its own
// unit tests (observations.test.ts), and this file asserts only how the board row
// presents what it hands back.
vi.mock("./observations", () => ({
  measureConsoleObservation: () => obsMock(),
  formatObservationUtc: (unix: number) => `${new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`,
}));

// No test should ever open a database connection: the storage read is asserted to
// degrade to "no feed" instead, which is exactly what a production outage looks like.
vi.mock("./db", () => ({ getDb: async () => null }));

import { buildCloudRow, CLOUD_SERVICE_DEFS, loadCloudBoard, summariseCloudBoard, type CloudServiceRow } from "./cloud-quota";

function def(key: string) {
  const found = CLOUD_SERVICE_DEFS.find(item => item.key === key);
  if (!found) throw new Error(`registry is missing ${key}`);
  return found;
}

describe("every ceiling on the board can be traced", () => {
  it("carries the document each limit came from", () => {
    for (const item of CLOUD_SERVICE_DEFS) {
      expect(item.limitSource, `${item.key} has no stated source for its limit`).toBeTruthy();
      expect(item.limitSource.length).toBeGreaterThan(12);
    }
  });

  it("registers unique keys so a row can never be confused with another", () => {
    const keys = CLOUD_SERVICE_DEFS.map(item => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tracks storage, the ceiling this product grows towards", () => {
    expect(def("tidb-storage").limit).toBeGreaterThan(0);
    expect(def("tidb-storage").feed).toBe("sql");
  });

  it("lists a ceiling with no feed as a gap rather than leaving it off the board", () => {
    const blind = CLOUD_SERVICE_DEFS.filter(item => item.limit !== null && item.feed === "none");
    expect(blind.length).toBeGreaterThan(0);
    for (const item of blind) {
      expect(buildCloudRow(item, null, "none").used).toBeNull();
    }
  });
});

describe("the 75% line is decided by the numbers, not by rounding", () => {
  const ceiling = { ...def("tidb-storage"), limit: 500, unit: "credits" };

  it("warns at exactly 75%", () => {
    const row = buildCloudRow(ceiling, 375, "database");
    expect(row.percent).toBe(75);
    expect(row.warn).toBe(true);
    expect(row.exhausted).toBe(false);
  });

  it("does not warn at 374 of 500, which rounds to 75 but is only 74.8", () => {
    const row = buildCloudRow(ceiling, 374, "database");
    expect(row.percent).toBe(74);
    expect(row.warn).toBe(false);
  });

  it("marks a spent ceiling exhausted, not merely full", () => {
    const row = buildCloudRow(ceiling, 500, "database");
    expect(row.exhausted).toBe(true);
    expect(row.warn).toBe(true);
    expect(row.percent).toBe(100);
  });
});

describe("unknown is never reported as unused", () => {
  const ceiling = def("vercel-data-transfer");

  it("leaves used, percent and warn empty when there is no feed", () => {
    const row = buildCloudRow(ceiling, null, "none");
    expect(row.used).toBeNull();
    expect(row.percent).toBeNull();
    expect(row.warn).toBe(false);
    expect(row.exhausted).toBe(false);
    expect(row.source).toBe("none");
  });

  it("does not compute a percentage against a limit that does not exist", () => {
    const row = buildCloudRow(def("paypal-allowance"), 1200, "database");
    expect(row.limit).toBeNull();
    expect(row.percent).toBeNull();
    expect(row.warn).toBe(false);
  });

  it("treats a zero ceiling as absent instead of dividing by it", () => {
    const row = buildCloudRow({ ...ceiling, limit: 0 }, 5, "database");
    expect(row.percent).toBeNull();
    expect(row.warn).toBe(false);
  });
});

describe("the board", () => {
  beforeEach(() => {
    quotaMock.mockReset();
    probeMock.mockReset();
    usageMock.mockReset();
    renderHoursMock.mockReset();
    obsMock.mockReset();
    persistMock.mockReset();
    probeMock.mockResolvedValue({ used: 0, reason: null });
    usageMock.mockResolvedValue({ used: 1, reason: null });
    renderHoursMock.mockResolvedValue({
      used: 92.42,
      reason: null,
      checkpoint: { metricKey: "render-instance-hours", periodKey: "2026-09", used: 332712, observedAtUnix: Math.floor(Date.now() / 1000), detail: "awake seconds" },
    });
    obsMock.mockResolvedValue({ used: 416_666, reason: null, observedAtUnix: Math.floor(Date.now() / 1000) - 600, detail: "console panel" });
    quotaMock.mockResolvedValue([
      { key: "scrappa", label: "Scrappa (Google Flights)", used: 8, limit: 500, percent: 1, period: "2026-09", warn: false, exhausted: false, wired: true, source: "database" },
      { key: "ignav", label: "Ignav", used: 0, limit: 1000, percent: 0, period: "lifetime", warn: false, exhausted: false, wired: true, source: "database" },
      { key: "brightdata", label: "Bright Data", used: 0, limit: 5000, percent: 0, period: "2026-09", warn: false, exhausted: false, wired: false, source: "database" },
    ]);
  });

  it("puts supplier credits first - they are what an alert depends on", async () => {
    const rows = await loadCloudBoard();
    expect(rows.slice(0, 3).map(row => row.category)).toEqual(["supplier", "supplier", "supplier"]);
    expect(rows.every(row => row.category === "supplier")).toBe(false);
  });

  it("keeps the reserve marked as a reserve rather than as available capacity", async () => {
    const rows = await loadCloudBoard();
    const reserve = rows.find(row => row.key === "brightdata-credits");
    expect(reserve?.wired).toBe(false);
    expect(reserve?.note).toMatch(/reserve/i);
  });

  it("reports the monthly and one-time allowances with the right reset", async () => {
    const rows = await loadCloudBoard();
    expect(rows.find(row => row.key === "scrappa-credits")?.period).toBe("month");
    expect(rows.find(row => row.key === "ignav-credits")?.period).toBe("lifetime");
  });

  it("reports an unreachable storage read as no feed, not as empty", async () => {
    const rows = await loadCloudBoard();
    const storage = rows.find(row => row.key === "tidb-storage");
    expect(storage).toBeDefined();
    expect(storage?.used).toBeNull();
    expect(storage?.feed).toBe("sql");
    expect(storage?.source).toBe("none");
  });

  it("leaves every counter it does not keep at null", async () => {
    const rows = await loadCloudBoard();
    for (const row of rows.filter(item => item.feed === "none")) {
      expect(row.used, `${row.key} must not report a usage figure`).toBeNull();
    }
  });

  it("survives a ledger that throws, rather than failing the whole report", async () => {
    quotaMock.mockRejectedValue(new Error("ledger unreachable"));
    const rows = await loadCloudBoard();
    expect(rows.length).toBe(CLOUD_SERVICE_DEFS.length);
    expect(rows.some(row => row.category === "supplier")).toBe(false);
  });

  it("never renders an unread supplier count as a healthy zero (the false-green guard)", async () => {
    // The production shape of a TiDB outage: loadQuotaStatus cannot read the ledger,
    // remembers no local charges, and hands back used = 0 with source = "none".
    // Rendered literally that row reads "0/500, Healthy" during the very outage the
    // board exists to expose - so it must come back as no number instead.
    quotaMock.mockResolvedValue([
      { key: "scrappa", label: "Scrappa (Google Flights)", used: 0, limit: 500, percent: 0, period: "2026-09", warn: false, exhausted: false, wired: true, source: "none" },
    ]);
    const rows = await loadCloudBoard();
    const row = rows.find(item => item.key === "scrappa-credits");
    expect(row).toBeDefined();
    expect(row?.used).toBeNull();
    expect(row?.percent).toBeNull();
    expect(row?.source).toBe("none");
    expect(row?.note).toMatch(/unreachable/i);
  });

  it("still reports a genuinely zero count when the ledger did answer", async () => {
    quotaMock.mockResolvedValue([
      { key: "ignav", label: "Ignav", used: 0, limit: 1000, percent: 0, period: "lifetime", warn: false, exhausted: false, wired: true, source: "database" },
    ]);
    const rows = await loadCloudBoard();
    const row = rows.find(item => item.key === "ignav-credits");
    expect(row?.used).toBe(0);
    expect(row?.percent).toBe(0);
    expect(row?.source).toBe("database");
  });

  it("measures Render's hours from its own metrics API, against the documented 750-hour ceiling", async () => {
    const rows = await loadCloudBoard();
    const hours = rows.find(row => row.key === "render-instance-hours");
    expect(hours).toBeDefined();
    expect(hours?.limit).toBe(750);
    expect(hours?.feed).toBe("api");
    expect(hours?.used).toBe(92.42);
    expect(hours?.percent).toBe(12);
    expect(hours?.warn).toBe(false);
    expect(hours?.source).toBe("api");
    expect(hours?.limitSource).toMatch(/render\.com\/docs\/free/);
    // The row says out loud that Render's billing page - not this reconstruction -
    // is the authority, with the day the two were compared.
    expect(hours?.note).toMatch(/billing page remains the authority/i);
    // A successful measurement refreshes the checkpoint that carries earlier hours
    // past Render's 7-day metrics retention (the real persistRenderCheckpoint
    // unwraps the reading; this mock records what the loader handed it).
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(persistMock.mock.calls[0]?.[0]).toMatchObject({
      used: 92.42,
      checkpoint: { metricKey: "render-instance-hours", used: 332712 },
    });
  });

  it("shows a failed hours read as no number, with the reason on the row", async () => {
    renderHoursMock.mockResolvedValue({
      used: null,
      reason: "Render API key not configured (RENDER_API_KEY) - the hours are withheld, never assumed.",
      checkpoint: null,
    });
    const rows = await loadCloudBoard();
    const hours = rows.find(row => row.key === "render-instance-hours");
    expect(hours?.used).toBeNull();
    expect(hours?.percent).toBeNull();
    expect(hours?.feed).toBe("api");
    expect(hours?.source).toBe("none");
    expect(hours?.note).toMatch(/withheld, never assumed/);
  });

  it("shows TiDB's RU counter from the daily audit's console observation", async () => {
    const rows = await loadCloudBoard();
    const ru = rows.find(row => row.key === "tidb-ru");
    expect(ru?.feed).toBe("audit");
    expect(ru?.used).toBe(416_666);
    expect(ru?.percent).toBe(0);
    expect(ru?.source).toBe("database");
    expect(ru?.note).toMatch(/Console observation recorded/);
    expect(ru?.note).toMatch(/daily audit refreshes it/);
    expect(ru?.note).toMatch(/limited-sql-features/);
  });

  it("withholds a stale or missing console observation with the reason on the row", async () => {
    obsMock.mockResolvedValue({
      used: null,
      reason: "Last observation was 41.0 h old (recorded 2026-09-29 19:00 UTC) - withheld rather than shown as current. console panel",
      observedAtUnix: null,
      detail: "console panel",
    });
    const rows = await loadCloudBoard();
    const ru = rows.find(row => row.key === "tidb-ru");
    expect(ru?.used).toBeNull();
    expect(ru?.percent).toBeNull();
    expect(ru?.feed).toBe("audit");
    expect(ru?.source).toBe("none");
    expect(ru?.note).toMatch(/withheld rather than shown as current/);
  });

  it("counts only Fast Data Transfer as a ceiling with no feed at all", async () => {
    const summary = summariseCloudBoard(await loadCloudBoard());
    // Tidb's RU counter (daily audit) and Render's hours (metrics API) are read now;
    // deployments was already measured. The one remaining structural blind spot is
    // Vercel's Fast Data Transfer, whose reader Vercel paywalls behind Pro.
    expect(summary.blindSpots).toBe(1);
    const blind = (await loadCloudBoard()).filter(row => row.limit !== null && row.feed === "none");
    expect(blind.map(row => row.key)).toEqual(["vercel-data-transfer"]);
  });

  it("puts the primary engine on the board as a live probe against our own rule", async () => {
    const rows = await loadCloudBoard();
    const engine = rows.find(row => row.key === "render-engine");
    expect(engine).toBeDefined();
    expect(engine?.feed).toBe("probe");
    expect(engine?.limit).toBe(15);
    expect(engine?.limitSource).toMatch(/own engine rule/i);
    expect(engine?.category).toBe("hosting");
  });

  it("measures engine freshness against the 15-minute rule with E14's arithmetic", async () => {
    probeMock.mockResolvedValue({ used: 2, reason: null });
    const fresh = (await loadCloudBoard()).find(row => row.key === "render-engine");
    expect(fresh?.used).toBe(2);
    expect(fresh?.percent).toBe(13);
    expect(fresh?.warn).toBe(false);
    expect(fresh?.exhausted).toBe(false);
    expect(fresh?.source).toBe("probe");

    probeMock.mockResolvedValue({ used: 12, reason: null });
    const aging = (await loadCloudBoard()).find(row => row.key === "render-engine");
    expect(aging?.percent).toBe(80);
    expect(aging?.warn).toBe(true);
    expect(aging?.exhausted).toBe(false);

    probeMock.mockResolvedValue({ used: 20, reason: null });
    const stale = (await loadCloudBoard()).find(row => row.key === "render-engine");
    expect(stale?.exhausted).toBe(true);
  });

  it("shows a failed engine probe as no number, with the reason on the row", async () => {
    probeMock.mockResolvedValue({
      used: null,
      reason: "probe failed 06:00 UTC (timeout after 6000 ms) - engine number withheld, never assumed",
    });
    const rows = await loadCloudBoard();
    const engine = rows.find(row => row.key === "render-engine");
    expect(engine?.used).toBeNull();
    expect(engine?.percent).toBeNull();
    expect(engine?.source).toBe("none");
    expect(engine?.note).toMatch(/withheld, never assumed/);
  });

  it("counts Vercel deployments from the provider's own API against the 100-per-day window", async () => {
    const rows = await loadCloudBoard();
    const dep = rows.find(row => row.key === "vercel-deployments");
    expect(dep).toBeDefined();
    expect(dep?.feed).toBe("api");
    expect(dep?.used).toBe(1);
    expect(dep?.percent).toBe(1);
    expect(dep?.warn).toBe(false);
    expect(dep?.source).toBe("api");
    expect(dep?.limit).toBe(100);
    expect(dep?.limitSource).toMatch(/vercel\.com\/docs\/limits/);
  });

  it("shows a failed deployments read as no number, with the reason on the row", async () => {
    usageMock.mockResolvedValue({
      used: null,
      reason: "Vercel deployments API did not answer at read time - the count is withheld, never assumed.",
    });
    const rows = await loadCloudBoard();
    const dep = rows.find(row => row.key === "vercel-deployments");
    expect(dep?.used).toBeNull();
    expect(dep?.percent).toBeNull();
    expect(dep?.source).toBe("none");
    expect(dep?.note).toMatch(/withheld, never assumed/);
  });
});

describe("the roll-up", () => {
  const rows: CloudServiceRow[] = [
    buildCloudRow({ ...def("tidb-storage"), key: "a" }, 100, "database"),
    buildCloudRow({ ...def("vercel-data-transfer"), key: "b" }, null, "none"),
    buildCloudRow({ ...def("paypal-allowance"), key: "c" }, null, "none"),
  ];

  it("counts only rows it can actually read", () => {
    const summary = summariseCloudBoard(rows);
    expect(summary.total).toBe(3);
    expect(summary.monitored).toBe(1);
    // PayPal has no ceiling, so it is not a blind spot - there is nothing to fall short of.
    expect(summary.blindSpots).toBe(1);
    expect(summary.warn).toBe(0);
  });

  it("counts a spent ceiling as an incident", () => {
    const summary = summariseCloudBoard([buildCloudRow({ ...def("tidb-storage"), key: "a" }, 5 * 1024 ** 3, "database")]);
    expect(summary.exhausted).toBe(1);
    expect(summary.warn).toBe(1);
  });
});
