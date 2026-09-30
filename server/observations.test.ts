import { describe, expect, it } from "vitest";
import { evaluateObservation, type ObservationRead } from "./observations";

/**
 * The console-observation row (TiDB's RU counter) is only as current as its last
 * audit reading, so freshness is part of the number, not a footnote:
 *
 *  - fresh  → the value, shown with when it was read;
 *  - stale  → withheld with the age, because a days-old quota figure rendered as
 *             current is precisely the stale green that hides an approaching ceiling;
 *  - missing→ the reason, never a 0 that would read as "nothing consumed".
 */

const AT = new Date(Date.parse("2026-09-30T12:00:00Z"));
const HOUR = 60 * 60 * 1000;

function read(unixSeconds: number): ObservationRead {
  return {
    observation: { metricKey: "tidb-ru", periodKey: "2026-09", used: 416_666, observedAtUnix: unixSeconds, detail: "console panel" },
    reason: null,
  };
}

describe("observation freshness", () => {
  it("presents a reading recorded moments ago with its provenance", () => {
    const result = evaluateObservation(read(Math.floor(AT.getTime() / 1000) - 600), AT, 30 * HOUR);
    expect(result.used).toBe(416_666);
    expect(result.reason).toBeNull();
    expect(result.detail).toBe("console panel");
    expect(result.observedAtUnix).toBe(Math.floor(AT.getTime() / 1000) - 600);
  });

  it("withholds a reading older than the freshness window, with its age in the reason", () => {
    const observedAt = Math.floor(AT.getTime() / 1000) - Math.floor(31.5 * 3600);
    const result = evaluateObservation(read(observedAt), AT, 30 * HOUR);
    expect(result.used).toBeNull();
    expect(result.reason).toMatch(/31\.5 h old/);
    expect(result.reason).toMatch(/withheld rather than shown as current/);
    // The moment itself survives on the row, so "when did anyone last check?" stays answerable.
    expect(result.observedAtUnix).toBe(observedAt);
  });

  it("accepts small clock skew between two machines reading the same reality", () => {
    const fromTheFuture = Math.floor(AT.getTime() / 1000) + 30;
    expect(evaluateObservation(read(fromTheFuture), AT, 30 * HOUR).used).toBe(416_666);
    const absurdlyEarly = Math.floor(AT.getTime() / 1000) + 3600;
    expect(evaluateObservation(read(absurdlyEarly), AT, 30 * HOUR).used).toBeNull();
  });

  it("passes through why an observation is missing instead of inventing a zero", () => {
    const result = evaluateObservation({ observation: null, reason: "no observation recorded yet for this metric" }, AT, 30 * HOUR);
    expect(result.used).toBeNull();
    expect(result.reason).toMatch(/no observation recorded yet/);
    expect(result.observedAtUnix).toBeNull();
  });
});
