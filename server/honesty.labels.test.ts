import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * P1 honesty guards over the rendered copy.
 *
 * These are literal strings that shipped on fareloop.in and were caught by checking
 * production rather than the source: a chart claiming "22% this month" it never
 * computed, an insight claiming a "lowest 15% of prices we've seen" we never held,
 * a results header that labelled live supplier quotes "Sample data (demo)" because
 * its ternary had no live branch, and an API returning a `plan` it had no context to
 * know. None of it was covered by a test, so it came back to the page unnoticed.
 *
 * The guard is text-based on purpose: it fails the moment a hardcoded claim is
 * reintroduced into the copy, without needing a browser to render it.
 */
const home = readFileSync(new URL("../client/src/pages/Home.tsx", import.meta.url), "utf8");
const routers = readFileSync(new URL("../server/routers.ts", import.meta.url), "utf8");
// Comments are allowed to quote what was wrong — only rendered copy is under test.
const homeCopy = home
  .split("\n")
  .filter(line => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
  .join("\n");

// Every client source file, so a supplier name cannot creep back in through a
// component other than Home.
const clientRoot = fileURLToPath(new URL("../client/src/", import.meta.url));
const clientFiles: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry)) clientFiles.push(full);
  }
};
walk(clientRoot);
const clientText = clientFiles.map(file => readFileSync(file, "utf8")).join("\n");

describe("we do not claim an affiliation we do not have", () => {
  it("never names an upstream fare supplier in client copy", () => {
    // `offer.provider` is plumbing, not endorsement: it is the supplier we buy
    // credits from (quota.ts maps "Google Flights" -> scrappa). We hold no Google
    // relationship, and a vendor the customer never deals with tells them nothing
    // they can check. The live label states liveness and quote count instead.
    for (const name of ["Google Flights", "Scrappa", "Ignav"]) {
      expect(clientText, `client source must not name ${name}`).not.toContain(name);
    }
  });
});

describe("no invented claims in the copy", () => {
  it("never hardcodes a price-change percentage", () => {
    // A fixed figure next to live data is an invention: it does not move when the data does.
    expect(homeCopy).not.toContain("22% this month");
    expect(homeCopy).not.toMatch(/↓\s*\d+% this month/);
    expect(homeCopy).not.toMatch(/↓\s*\d+% below avg/);
    // The hero chip carried an unsourced "22% lower" next to real search results.
    expect(homeCopy).not.toContain('> 22% lower<');
  });

  it("never claims a price history we have not kept", () => {
    expect(homeCopy).not.toContain("lowest 15%");
    expect(homeCopy).not.toMatch(/prices we.{0,4}ve seen/);
    // Percentiles and booking-time advice we have no model for.
    expect(homeCopy).not.toContain("of fares (demo)");
    expect(homeCopy).not.toContain("Best time to book (demo)");
    expect(homeCopy).not.toContain("5\u20137 weeks out");
  });

  it("never labels the price chart as demo regardless of what it fetched", () => {
    expect(home).not.toContain("Price trend (demo)");
    // Provenance must be derived from the server response instead.
    expect(home).toContain('sourceLabel = source === "live"');
  });
});

describe("live results are never labelled as sample", () => {
  it("the results meta has a branch for a live search", () => {
    // The original ternary only tested for "estimate", so source === "live" fell
    // through to the else and real quotes were captioned "Sample data (demo)".
    expect(home).toContain('searchMutation.data?.source === "live"');
    expect(home).toContain("Live fares · ${searchMutation.data.offers.length} quotes");
  });

  it("keeps an honest label for the genuinely-sample default state", () => {
    expect(home).toContain("Sample data (demo)");
  });
});

describe("the chart draws only geometry it actually has", () => {
  it("guards the polyline against a single reading", () => {
    // With one point, index / (points.length - 1) is 0/0 and emitted `NaN,12`,
    // which the browser dropped - an empty chart under a confident headline.
    expect(home).toContain("const canDraw = points.length > 1 && max > min;");
    expect(home).not.toMatch(/const polyline = points\.map\(\(point, index\) => `\$\{\(index \/ \(points\.length - 1\)\)/);
  });
});

describe("claims about how the product behaves", () => {
  it("states the scan cadence the cron actually runs on", () => {
    // vercel.json is a single daily job at 0 12 * * * (12:00 UTC). Copy claiming a
    // 12-hour cadence, or a "last scan 12 minutes ago" that nothing computed, was fiction.
    expect(homeCopy).not.toContain("every 12 hours");
    expect(homeCopy).not.toContain("Last scan completed 12 minutes ago");
    expect(homeCopy).not.toContain("updated 12 min ago");
    expect(homeCopy).toContain("12:00 UTC");
  });

  it("never promises history depth we have not collected", () => {
    // We hold one reading per route on day one; history returns `gated: false`,
    // so nothing is being unlocked either.
    expect(homeCopy).not.toContain("12 months of route trends");
    expect(homeCopy).not.toContain("190+ countries");
    expect(homeCopy).not.toMatch(/Last scan completed \d+ (minutes|hours) ago/);
  });
});

describe("the API does not invent fields it cannot know", () => {
  it("tracker.list returns no plan value", () => {
    // publicProcedure carries no user context, so any plan here would be fabricated.
    expect(routers).not.toContain("demo-free");
    expect(routers).not.toMatch(/return \{ routes: listTrackedRoutes\(\), plan/);
  });
});
