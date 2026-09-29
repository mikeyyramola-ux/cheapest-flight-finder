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

const { quotaMock } = vi.hoisted(() => ({ quotaMock: vi.fn() }));

vi.mock("./quota", async () => {
  const actual = await vi.importActual<typeof import("./quota")>("./quota");
  return { ...actual, loadQuotaStatus: () => quotaMock() };
});

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
