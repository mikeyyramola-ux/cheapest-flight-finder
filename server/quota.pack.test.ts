import { afterEach, describe, expect, it } from "vitest";
import {
  availableLimit,
  buildQuotaStatus,
  QUOTA_PROVIDERS,
  quotaPeriodKey,
  SCRAPPA_PACK,
  scrappaCombined,
} from "./quota";

/**
 * PROPOSAL 20: the Scrappa free pool (500/month) and the one-time Starter pack
 * (33,000, 12-month expiry) are one balance wearing two rows.
 *
 * The three things that could quietly go wrong, asserted here rather than assumed:
 *
 *   1. a month rolling over must NOT re-grant the pack - if it did, the pack would
 *      be an unbounded monthly allowance wearing a one-time label, which is exactly
 *      the kind of slow bleed this ledger exists to make visible;
 *   2. an expired pack must drop out of every total, with no cron and no column;
 *   3. the 75% line is measured against the TOTAL available pool.
 *
 * Everything is pure, so all three are asserted exactly instead of being
 * approximated through a mocked database.
 */

const ORIGINAL = {
  limit: SCRAPPA_PACK.limit,
  issuedAt: SCRAPPA_PACK.issuedAt,
  validMonths: SCRAPPA_PACK.validMonths,
};

/** Stands in for the owner saying CONFIRM 20. */
function buyPack(issuedAt: string, limit = 33_000) {
  SCRAPPA_PACK.limit = limit;
  SCRAPPA_PACK.issuedAt = issuedAt;
}

afterEach(() => {
  SCRAPPA_PACK.limit = ORIGINAL.limit;
  SCRAPPA_PACK.issuedAt = ORIGINAL.issuedAt;
  SCRAPPA_PACK.validMonths = ORIGINAL.validMonths;
});

const provider = (key: string) => QUOTA_PROVIDERS.find(item => item.key === key)!;

describe("scrappa pack (PROPOSAL 20)", () => {
  it("is worth nothing until the owner buys it", () => {
    const pack = provider("scrappa-pack");
    expect(pack.limit).toBe(0);
    expect(availableLimit(pack)).toBe(0);

    const rows = buildQuotaStatus({}, "database");
    const row = rows.find(item => item.key === "scrappa-pack");
    expect(row?.limit).toBe(0);
    // Worth nothing is NOT the same as empty: it must stay quiet rather than raise
    // a red flag nobody can ever clear.
    expect(row?.warn).toBe(false);
    expect(row?.exhausted).toBe(false);
    expect(scrappaCombined(rows).limit).toBe(500);
  });

  it("does not re-grant the pack when the month rolls over", () => {
    buyPack("2026-10-05");
    const oct = new Date("2026-10-31T23:59:00Z");
    const nov = new Date("2026-11-01T00:01:00Z");

    // The free pool moves to a fresh row - that IS the monthly refill.
    expect(quotaPeriodKey(provider("scrappa"), oct)).toBe("2026-10");
    expect(quotaPeriodKey(provider("scrappa"), nov)).toBe("2026-11");

    // The pack stays on the row it was bought under, so its spend survives the
    // rollover untouched. A rollover changing this key would silently zero it.
    expect(quotaPeriodKey(provider("scrappa-pack"), oct)).toBe("pack-2026-10");
    expect(quotaPeriodKey(provider("scrappa-pack"), nov)).toBe("pack-2026-10");
    // ...and it can never collide with a free-pool row.
    expect(quotaPeriodKey(provider("scrappa-pack"), nov)).not.toBe("2026-11");
  });

  it("carries pack spend across a rollover while the free pool starts empty", () => {
    buyPack("2026-10-05");
    const oct = new Date("2026-10-31T23:59:00Z");
    const nov = new Date("2026-11-01T00:01:00Z");

    const before = scrappaCombined(
      buildQuotaStatus({ scrappa: 400, "scrappa-pack": 100 }, "database", oct),
    );
    // On the 1st the free row is brand new and empty; the pack row still carries
    // every credit already spent against it.
    const after = scrappaCombined(
      buildQuotaStatus({ scrappa: 0, "scrappa-pack": 100 }, "database", nov),
    );

    expect(before.used).toBe(500);
    expect(after.used).toBe(100);
    expect(after.limit).toBe(33_500);
  });

  it("drops the pack out of every total the moment it expires", () => {
    buyPack("2026-10-05");
    const dayBefore = new Date("2027-10-04T12:00:00Z");
    const onExpiry = new Date("2027-10-05T00:00:00Z");

    const pack = provider("scrappa-pack");
    expect(availableLimit(pack, dayBefore)).toBe(33_000);
    expect(availableLimit(pack, onExpiry)).toBe(0);

    // And because the limit is what buildQuotaStatus reports, the total the breaker
    // measures against shrinks with it - no cron, no expiry column, no migration.
    const before = buildQuotaStatus({}, "database", dayBefore);
    const after = buildQuotaStatus({}, "database", onExpiry);
    expect(scrappaCombined(before).limit).toBe(33_500);
    expect(scrappaCombined(after).limit).toBe(500);

    const expired = after.find(row => row.key === "scrappa-pack");
    expect(expired?.limit).toBe(0);
    expect(expired?.warn).toBe(false);
    expect(expired?.exhausted).toBe(false);
  });

  it("trips at 75% of the total available pool, not of either pool alone", () => {
    // Unpurchased: the total is the free pool only, so behaviour is unchanged from
    // before this proposal - 375 of 500, exactly 75%, and 374 stays quiet.
    const unpurchased = buildQuotaStatus({ scrappa: 375 }, "database");
    expect(scrappaCombined(unpurchased).limit).toBe(500);
    expect(scrappaCombined(unpurchased).percent).toBe(75);
    expect(scrappaCombined(unpurchased).warn).toBe(true);
    expect(scrappaCombined(buildQuotaStatus({ scrappa: 374 }, "database")).warn).toBe(false);

    // After CONFIRM 20 the total is 33,500, so the line moves to 25,125.
    buyPack("2026-10-05");
    const atLine = scrappaCombined(
      buildQuotaStatus({ scrappa: 500, "scrappa-pack": 24_625 }, "database"),
    );
    expect(atLine.limit).toBe(33_500);
    expect(atLine.used).toBe(25_125);
    expect(atLine.percent).toBe(75);
    expect(atLine.warn).toBe(true);

    const oneBelow = scrappaCombined(
      buildQuotaStatus({ scrappa: 500, "scrappa-pack": 24_624 }, "database"),
    );
    expect(oneBelow.used).toBe(25_124);
    expect(oneBelow.warn).toBe(false);
  });
});
