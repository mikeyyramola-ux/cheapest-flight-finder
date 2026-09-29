import { describe, expect, it } from "vitest";
import { buildQuotaStatus, chargeQuota, QUOTA_PROVIDERS, QUOTA_WARN_PERCENT, quotaPeriodKey } from "./quota";

/**
 * The quota ledger itself: the boundary arithmetic and the period keys that decide
 * which row a credit lands in. These are pure, so the 75% line is asserted exactly
 * instead of being approximated through a mocked database.
 *
 * A credit counted into the wrong period is worse than no count at all: it would
 * reset a spent pool back to zero on the 1st of the month and silence the one
 * warning we have.
 */

describe("quota ledger", () => {
  it("sets the E14 threshold at 75%", () => {
    expect(QUOTA_WARN_PERCENT).toBe(75);
  });

  it("flags exactly at 75% and stays quiet at 74%", () => {
    const at75 = buildQuotaStatus({ scrappa: 375 }, "database");
    const at74 = buildQuotaStatus({ scrappa: 374 }, "database");

    const scrappaAt75 = at75.find(quota => quota.key === "scrappa");
    const scrappaAt74 = at74.find(quota => quota.key === "scrappa");

    expect(scrappaAt75?.percent).toBe(75);
    expect(scrappaAt75?.warn).toBe(true);
    expect(scrappaAt75?.exhausted).toBe(false);

    expect(scrappaAt74?.percent).toBe(74);
    expect(scrappaAt74?.warn).toBe(false);
  });

  it("reports an exhausted pool as exhausted, not merely as a high percentage", () => {
    const ignav = buildQuotaStatus({ ignav: 1000 }, "database").find(quota => quota.key === "ignav");
    expect(ignav?.percent).toBe(100);
    expect(ignav?.warn).toBe(true);
    expect(ignav?.exhausted).toBe(true);
  });

  it("treats an unknown key as zero rather than inventing usage", () => {
    const status = buildQuotaStatus({}, "none");
    for (const quota of status) {
      expect(quota.used).toBe(0);
      expect(quota.percent).toBe(0);
      expect(quota.warn).toBe(false);
    }
  });

  it("reports all three suppliers, marking Bright Data as not wired in", () => {
    const status = buildQuotaStatus({}, "database");
    expect(status.map(quota => quota.key)).toEqual(["scrappa", "ignav", "brightdata"]);
    expect(status.find(quota => quota.key === "brightdata")?.wired).toBe(false);
    expect(status.find(quota => quota.key === "scrappa")?.wired).toBe(true);
  });

  it("gives each supplier its published allowance", () => {
    const limits = Object.fromEntries(QUOTA_PROVIDERS.map(provider => [provider.key, provider.limit]));
    expect(limits).toEqual({ scrappa: 500, ignav: 1000, brightdata: 5000 });
  });

  it("buckets monthly pools by UTC month and one-time pools under lifetime", () => {
    const at = new Date(Date.UTC(2026, 8, 29, 12, 0, 0)); // September 2026
    const scrappa = QUOTA_PROVIDERS.find(provider => provider.key === "scrappa");
    const ignav = QUOTA_PROVIDERS.find(provider => provider.key === "ignav");

    expect(quotaPeriodKey(scrappa!, at)).toBe("2026-09");
    // Never resets: a lifetime pool rolled into a month key would silently zero it.
    expect(quotaPeriodKey(ignav!, at)).toBe("lifetime");
    expect(quotaPeriodKey(scrappa!, new Date(Date.UTC(2026, 11, 31)))).toBe("2026-12");
  });

  it("counts nothing for a supplier it cannot map, rather than the wrong one", async () => {
    // No key, no database: the call must resolve without throwing and without
    // attributing the credit to a supplier we did not spend it with.
    await expect(chargeQuota("Unknown Airline")).resolves.toBeUndefined();
    await expect(chargeQuota("")).resolves.toBeUndefined();
  });

  it("gives each row the source of ITS OWN number, not the report's", () => {
    // The database may hold one pool while another pool only exists in this
    // instance's memory (its write never landed). Crediting the memory-only row
    // with the database's authority would let an unsaved count read as verified.
    const status = buildQuotaStatus({ scrappa: 10, ignav: 40 }, "database", new Date(), {
      scrappa: "database",
      ignav: "instance-memory",
    });

    expect(status.find(quota => quota.key === "scrappa")?.source).toBe("database");
    expect(status.find(quota => quota.key === "ignav")?.source).toBe("instance-memory");
    // Bright Data has no count anywhere: the query still ran and found zero, so the
    // report-level source correctly describes where that zero came from.
    expect(status.find(quota => quota.key === "brightdata")?.source).toBe("database");
  });

  it("falls back to the instance view when storage is not configured at all", () => {
    const status = buildQuotaStatus({}, "none");
    expect(status.every(quota => quota.source === "none")).toBe(true);
  });
});
