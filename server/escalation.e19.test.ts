import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectCloudBoardAlerts,
  CRON_HEARTBEAT_KEY,
  CRON_HEARTBEAT_STALE_MS,
  OWNER_ALERT_CODES,
} from "./board-escalation";
import type { BoardObservation, ObservationRead } from "./observations";

/**
 * E19 - the cron's heartbeat (owner GO 2026-09-30: "proves the run forever, no
 * Vercel logs needed").
 *
 * scheduled.ts stamps `cron:last-run` at the end of every successful daily run;
 * the NEXT run compares that stamp's age against 25 h and reports a gap. What
 * this file pins down:
 *
 *  - A fresh stamp is silence - no message, no alert (a heartbeat that cries
 *    wolf daily stops being read, same rule as the alert dedup).
 *  - A stamp older than the window is exactly one E19, built from the stored
 *    timestamp itself - never a rounded or remembered age.
 *  - A missing stamp is NOT an alert: the first deploy after this ships has
 *    nothing to compare, and absence must not be dressed up as a finding.
 *  - A future stamp cannot mean "missed" either - negative age is not staleness.
 *
 * The store and the sender are mocked in-memory; nothing here touches the
 * database, Vercel, or the owner's actual chat.
 */

const { loadMock, readMock, sendMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  readMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock("./cloud-quota", async () => {
  const actual = await vi.importActual<typeof import("./cloud-quota")>("./cloud-quota");
  return { ...actual, loadCloudBoard: (...args: unknown[]) => loadMock(...args) };
});

vi.mock("./observations", async () => {
  const actual = await vi.importActual<typeof import("./observations")>("./observations");
  return {
    ...actual,
    readBoardObservation: (key: string) => readMock(key),
    saveBoardObservation: (observation: BoardObservation) => Promise.resolve(),
  };
});

vi.mock("./telegram", () => ({
  deliverTelegram: (message: string) => sendMock(message),
}));

const AT = new Date("2026-09-30T12:00:00.000Z");
const AT_UNIX = Math.floor(AT.getTime() / 1000);
const HOUR = 3_600;

type StoredRow = { used: number; observedAtUnix: number; detail: string; periodKey?: string };

/** metric_key -> stored reading (heartbeat + the audit rows E18 inspects). */
let metrics: Map<string, StoredRow>;

function observationRead(key: string): ObservationRead {
  const found = metrics.get(key);
  if (!found) return { observation: null, reason: "no observation recorded yet for this metric" };
  return {
    observation: {
      metricKey: key,
      periodKey: found.periodKey ?? "2026-09",
      used: found.used,
      observedAtUnix: found.observedAtUnix,
      detail: found.detail,
    },
    reason: null,
  };
}

/** Fresh audit readings so E18 stays quiet and the E19 assertions stand alone. */
function seedAudit() {
  metrics.set("tidb-ru", { used: 1, observedAtUnix: AT_UNIX - HOUR, detail: "fresh" });
  metrics.set("vercel-data-transfer", { used: 1, observedAtUnix: AT_UNIX - HOUR, detail: "fresh" });
}

function seedHeartbeat(ageSeconds: number, atUnix = AT_UNIX) {
  metrics.set(CRON_HEARTBEAT_KEY, {
    used: atUnix - ageSeconds,
    observedAtUnix: atUnix - ageSeconds,
    detail: "[cron] run ok (test seed)",
  });
}

beforeEach(() => {
  metrics = new Map();
  loadMock.mockReset();
  readMock.mockReset();
  sendMock.mockReset();
  loadMock.mockResolvedValue([]);
  readMock.mockImplementation((key: string) => Promise.resolve(observationRead(key)));
  sendMock.mockResolvedValue(true);
  seedAudit();
});

describe("E19 heartbeat", () => {
  it("is a first-class owner alert code with its own message copy", () => {
    expect(OWNER_ALERT_CODES).toContain("E19");
  });

  it("stays silent on a fresh heartbeat", async () => {
    seedHeartbeat(60);                                    // stamped one minute ago
    const scan = await collectCloudBoardAlerts(AT);
    expect(scan.failure).toBeNull();
    expect(scan.alerts.filter(alert => alert.code === "E19")).toHaveLength(0);
    expect(scan.alerts).toHaveLength(0);                   // board empty, audits fresh
  });

  it("stays silent while the heartbeat is inside the 25 h window", async () => {
    seedHeartbeat(CRON_HEARTBEAT_STALE_MS / 1000 - 60);    // 24 h old, window not crossed
    const scan = await collectCloudBoardAlerts(AT);
    expect(scan.alerts.filter(alert => alert.code === "E19")).toHaveLength(0);
  });

  it("reports exactly one E19 when the heartbeat is older than the window", async () => {
    seedHeartbeat(30 * HOUR);                              // a full daily run missed
    const scan = await collectCloudBoardAlerts(AT);
    const e19 = scan.alerts.filter(alert => alert.code === "E19");
    expect(e19).toHaveLength(1);
    expect(e19[0].key).toBe("cron-heartbeat");
    // The age comes from the stored timestamp itself - 30 h, said plainly.
    expect(e19[0].line).toContain("30.0 h old");
    expect(e19[0].line).toContain("missed");
  });

  it("says nothing when no heartbeat exists yet (first deploy, nothing to compare)", async () => {
    const scan = await collectCloudBoardAlerts(AT);
    expect(scan.alerts.filter(alert => alert.code === "E19")).toHaveLength(0);
  });

  it("does not treat a future-stamped heartbeat as missed", async () => {
    metrics.set(CRON_HEARTBEAT_KEY, {
      used: AT_UNIX + HOUR,
      observedAtUnix: AT_UNIX + HOUR,
      detail: "[cron] run ok (test seed, clock ahead)",
    });
    const scan = await collectCloudBoardAlerts(AT);
    expect(scan.alerts.filter(alert => alert.code === "E19")).toHaveLength(0);
  });
});
