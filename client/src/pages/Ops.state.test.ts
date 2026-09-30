import { describe, expect, it } from "vitest";
import { rowState, type CloudRow } from "./Ops";

/**
 * The state of a row is the board's whole vocabulary for "what should the operator
 * do", so a wire failure has to be distinguishable from silence at a glance:
 *
 *  - exhausted / warn / ok  - a number we read, and what it means;
 *  - unreachable            - the live probe ran and failed just now. Different from
 *                             "Not monitored", which is a metric nobody feeds at all;
 *  - nofeed / noquota       - no counter exists for this ceiling.
 *
 * The distinction is the anti-false-green rule made visible: during an outage the
 * board must never reach "Healthy" from a number it did not read.
 */

function row(overrides: Partial<CloudRow>): CloudRow {
  return {
    key: "k",
    service: "S",
    category: "hosting",
    metric: "M",
    unit: "min",
    limit: 15,
    period: "standing",
    used: null,
    percent: null,
    warn: false,
    exhausted: false,
    wired: true,
    feed: "probe",
    source: "none",
    limitSource: "own rule",
    note: null,
    ...overrides,
  };
}

describe("row state vocabulary", () => {
  it("calls a live read that failed 'Read failed', not 'Not monitored'", () => {
    expect(rowState(row({ feed: "probe", used: null, percent: null }))).toBe("unreachable");
  });

  it("calls a provider API read that failed the same dark state as a failed probe", () => {
    // The deployments row is a REST API feed: when Vercel does not answer, the row
    // must show a failed read, not the grey of a metric nobody keeps.
    expect(rowState(row({ feed: "api", used: null, percent: null }))).toBe("unreachable");
  });

  it("calls a probe that answered healthy while it is young", () => {
    expect(rowState(row({ feed: "probe", used: 2, percent: 13, source: "probe" }))).toBe("ok");
  });

  it("warns at 75% of the engine rule like any other ceiling", () => {
    expect(rowState(row({ feed: "probe", used: 12, percent: 80, warn: true }))).toBe("warn");
  });

  it("reports an exhausted ceiling as an incident state", () => {
    expect(rowState(row({ feed: "probe", used: 20, percent: 133, warn: true, exhausted: true }))).toBe("exhausted");
  });

  it("keeps a ceiling nobody watches grey", () => {
    expect(rowState(row({ feed: "none", limit: 750, used: null, percent: null }))).toBe("nofeed");
  });

  it("keeps a ceiling that does not exist grey of a different kind", () => {
    expect(rowState(row({ feed: "none", limit: null, used: null, percent: null }))).toBe("noquota");
  });

  it("never reaches a green state from an unread supplier row", () => {
    const unread = row({ feed: "ledger", unit: "credits", used: null, percent: null, source: "none" });
    expect(rowState(unread)).toBe("nofeed");
  });
});
