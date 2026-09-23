import { describe, expect, it } from "vitest";
import {
  DESTINATIONS,
  DESTINATION_PATHS,
  DESTINATION_REGIONS,
  POPULAR_ORIGIN_HUBS,
  airportOptions,
  cheapestMonthLabel,
  destinationByCode,
  destinationBySlug,
  destinationPath,
  hubLabel,
  monthLabel,
} from "./destinations";

describe("destination dataset", () => {
  it("keeps slugs, codes, and paths unique", () => {
    const slugs = DESTINATIONS.map(d => d.slug);
    const codes = DESTINATIONS.map(d => d.code);
    expect(new Set(slugs).size).toBe(DESTINATIONS.length);
    expect(new Set(codes).size).toBe(DESTINATIONS.length);
    expect(new Set(DESTINATION_PATHS).size).toBe(DESTINATIONS.length);
  });

  it("produces ascii-safe slugs", () => {
    expect(destinationByCode("GRU")?.slug).toBe("sao-paulo");
    expect(destinationByCode("DEL")?.slug).toBe("new-delhi");
    for (const dest of DESTINATIONS) expect(dest.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("has non-empty unique long-form copy for every page", () => {
    const blurbs = DESTINATIONS.map(d => d.blurb);
    expect(new Set(blurbs).size).toBe(DESTINATIONS.length);
    for (const dest of DESTINATIONS) {
      expect(dest.blurb.length).toBeGreaterThan(120);
      expect(dest.season.length).toBeGreaterThan(60);
      expect(dest.airport.length).toBeGreaterThan(2);
      expect(DESTINATION_REGIONS).toContain(dest.region);
    }
  });

  it("resolves lookups and keeps the airport dropdown shape stable", () => {
    const london = destinationBySlug("london");
    expect(london?.code).toBe("LHR");
    expect(destinationPath("london")).toBe("/flights-to/london");
    expect(hubLabel("JFK")).toBe("New York");
    expect(airportOptions).toHaveLength(DESTINATIONS.length);
    expect(Object.keys(airportOptions[0] ?? {}).sort()).toEqual(["airport", "city", "code", "country"]);
    for (const hub of POPULAR_ORIGIN_HUBS) expect(destinationByCode(hub)).toBeTruthy();
    expect(destinationBySlug("not-a-city")).toBeUndefined();
  });

  it("marks honest, valid cheapest-month windows for every city", () => {
    for (const dest of DESTINATIONS) {
      expect(dest.cheapestMonths.length, `${dest.city} needs a window`).toBeGreaterThanOrEqual(1);
      expect(dest.cheapestMonths.length, `${dest.city} window should stay meaningful`).toBeLessThanOrEqual(10);
      expect(new Set(dest.cheapestMonths).size, `${dest.city} months must be unique`).toBe(dest.cheapestMonths.length);
      for (const month of dest.cheapestMonths) {
        expect(month, `${dest.city} month out of range: ${month}`).toBeGreaterThanOrEqual(1);
        expect(month, `${dest.city} month out of range: ${month}`).toBeLessThanOrEqual(12);
      }
    }
  });

  it("compresses month windows into readable labels", () => {
    expect(monthLabel([3, 4, 5, 9, 10, 11])).toBe("Mar–May, Sep–Nov");
    expect(monthLabel([1, 2])).toBe("Jan–Feb");
    expect(monthLabel([6, 7, 8, 9, 10, 11])).toBe("Jun–Nov");
    expect(monthLabel([1])).toBe("Jan");
    expect(monthLabel([12, 1, 2])).toBe("Jan–Feb, Dec");
    expect(cheapestMonthLabel(destinationByCode("LHR")!)).toBe("Jan–Mar, May–Jun, Oct–Nov");
  });
});
