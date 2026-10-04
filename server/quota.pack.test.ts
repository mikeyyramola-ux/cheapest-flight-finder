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
  it("is in play for 33,500 now that the owner has confirmed the purchase", () => {
    // CONFIRM 20, 2026-10-04: the two activation fields are set, so the pack reports
    // its real worth and joins the free pool to make one balance.
    const pack = provider("scrappa-pack");
    expect(SCRAPPA_PACK.limit).toBe(33_000);
    expect(SCRAPPA_PACK.issuedAt).toBe("2026-10-04");
    expect(pack.limit).toBe(33_000);
    expect(availableLimit(pack)).toBe(33_000);

    const rows = buildQuotaStatus({}, "database");
    expect(rows.find(item => item.key === "scrappa-pack")?.limit).toBe(33_000);
    expect(scrappaCombined(rows).limit).toBe(33_500);

    // Expiry is derived from the issue date, never stored: alive the day before,
    // worth nothing at midnight on the anniversary.
    expect(availableLimit(pack, new Date("2027-10-03T12:00:00Z"))).toBe(33_000);
    expect(availableLimit(pack, new Date("2027-10-04T00:00:00Z"))).toBe(0);
  });

  it("keeps a pack that is not in play silent rather than flagging it", () => {
    // The invariant, driven explicitly instead of by the production default: a pool
    // worth 0 is not empty, it is absent, and it must never raise a red flag nobody
    // could ever clear. A withdrawn or already-expired pack falls back to the free
    // pool's 500-credit ceiling, which is what the breaker judged before CONFIRM 20.
    SCRAPPA_PACK.limit = 0;
    SCRAPPA_PACK.issuedAt = "";

    expect(availableLimit(provider("scrappa-pack"))).toBe(0);

    const rows = buildQuotaStatus({}, "database");
    const row = rows.find(item => item.key === "scrappa-pack");
    expect(row?.limit).toBe(0);
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
    // CONFIRM 20: the pack is bought, so the total is 33,500 and the line is 25,125 -
    // not 375. That is precisely what the purchase buys: 375 credits into the free
    // pool is 75% of that pool but only 1.1% of the balance, and it is the balance
    // that empties.
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

    // The free pool can be spent out completely without tripping anything, because
    // the pack behind it is untouched - the buffer the pack was bought to provide.
    const freeOnly = scrappaCombined(
      buildQuotaStatus({ scrappa: 500, "scrappa-pack": 0 }, "database"),
    );
    expect(freeOnly.used).toBe(500);
    expect(freeOnly.percent).toBe(1);
    expect(freeOnly.warn).toBe(false);

    // With the pack withdrawn the ceiling falls back to the free pool alone, so the
    // breaker still behaves exactly as it did before CONFIRM 20: 375 of 500 trips it
    // and 374 stays quiet.
    SCRAPPA_PACK.limit = 0;
    SCRAPPA_PACK.issuedAt = "";
    const unpurchased = buildQuotaStatus({ scrappa: 375 }, "database");
    expect(scrappaCombined(unpurchased).limit).toBe(500);
    expect(scrappaCombined(unpurchased).percent).toBe(75);
    expect(scrappaCombined(unpurchased).warn).toBe(true);
    expect(scrappaCombined(buildQuotaStatus({ scrappa: 374 }, "database")).warn).toBe(false);
  });
});
