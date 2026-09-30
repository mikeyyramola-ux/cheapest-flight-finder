import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_REMIND_MS,
  AUDIT_OVERDUE_MS,
  collectCloudBoardAlerts,
  sendOwnerAlerts,
  type OwnerAlert,
} from "./board-escalation";
import { buildCloudRow, CLOUD_SERVICE_DEFS, type CloudServiceRow } from "./cloud-quota";
import type { BoardObservation, ObservationRead } from "./observations";

/**
 * The quota board's Telegram voice (owner order, 2026-09-30: "for telegram yes wire
 * that"), in the three properties that make it safe to leave running unattended:
 *
 *  - It only speaks when a board row actually crossed 75% (E17) or a daily audit
 *    actually slipped past 24 h (E18) - built from the row's own numbers, never a
 *    rounded or remembered one.
 *  - It says a changed condition once and an unchanged one at most weekly (E14/E16/
 *    E17/E18 dedup), because a chat that cries daily stops being read.
 *  - It never swallows a failure: an unreadable board is reported (E16), and a message
 *    Telegram refused is not recorded as sent, so the next run tries again.
 *
 * The store and the sender are mocked in-memory; nothing here touches the database,
 * Render, Vercel, or the owner's actual chat.
 */

const { loadMock, readMock, saveMock, sendMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  readMock: vi.fn(),
  saveMock: vi.fn(),
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
    saveBoardObservation: (observation: BoardObservation) => saveMock(observation),
  };
});

vi.mock("./telegram", () => ({
  deliverTelegram: (message: string) => sendMock(message),
}));

const AT = new Date("2026-09-30T12:00:00.000Z");
const AT_UNIX = Math.floor(AT.getTime() / 1000);
const HOUR = 3_600;

type StoredRow = { used: number; observedAtUnix: number; detail: string; periodKey?: string };

/** metric_key -> stored reading (the daily audit's numbers); alert: keys live apart. */
let metrics: Map<string, StoredRow>;
/** alert:<code> -> what the cron last told Telegram (the dedup state). */
let states: Map<string, StoredRow>;
let storeUnreachable = false;
let telegramAccepted = true;
let saveThrowsOnce = false;

function observationRead(key: string): ObservationRead {
  if (storeUnreachable) return { observation: null, reason: "database not reachable at read time" };
  const found = (key.startsWith("alert:") ? states : metrics).get(key);
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

function defOf(key: string) {
  const found = CLOUD_SERVICE_DEFS.find(def => def.key === key);
  if (!found) throw new Error(`no board definition for ${key}`);
  return found;
}

/** A real board row for a real ceiling - built by the board's own pure builder, so the
 *  percent and warn flag under test are the production ones, not hand-typed copies. */
function boardRow(key: string, used: number): CloudServiceRow {
  return buildCloudRow(defOf(key), used, "api");
}

/** Supplier rows exist only on the live board (they are mapped from the credit
 *  ledger), so this one is written out - and categorised the way the loader does it. */
const supplierWarnRow: CloudServiceRow = {
  key: "scrappa-credits",
  service: "Scrappa",
  category: "supplier",
  metric: "Search credits",
  unit: "credits",
  limit: 500,
  period: "month",
  used: 420,
  percent: 84,
  warn: true,
  exhausted: false,
  wired: true,
  feed: "ledger",
  source: "database",
  limitSource: "Credit ledger we write at charge time",
  note: null,
};

/** Both audit rows freshly recorded, 3 h ago - the state a healthy morning audit leaves. */
function seedFreshAudits() {
  metrics.set("tidb-ru", { used: 416_666, observedAtUnix: AT_UNIX - 3 * HOUR, detail: "416,666 of 50,000,000 RU" });
  metrics.set("vercel-data-transfer", { used: 0.37443, observedAtUnix: AT_UNIX - 3 * HOUR, detail: "374.43 MB / 100 GB" });
}

beforeEach(() => {
  metrics = new Map();
  states = new Map();
  storeUnreachable = false;
  telegramAccepted = true;
  saveThrowsOnce = false;
  loadMock.mockReset();
  readMock.mockReset();
  saveMock.mockReset();
  sendMock.mockReset();
  readMock.mockImplementation(async (key: string) => observationRead(key));
  saveMock.mockImplementation(async (observation: BoardObservation) => {
    if (storeUnreachable) return; // a best-effort write that cannot reach the store
    if (saveThrowsOnce) {
      saveThrowsOnce = false;
      throw new Error("write refused");
    }
    const target = observation.metricKey.startsWith("alert:") ? states : metrics;
    target.set(observation.metricKey, {
      used: observation.used,
      observedAtUnix: observation.observedAtUnix,
      detail: observation.detail,
      periodKey: observation.periodKey,
    });
  });
  sendMock.mockImplementation(async (message: string) => ({
    channel: "Telegram" as const,
    message,
    delivered: telegramAccepted,
    reason: telegramAccepted ? "accepted by Telegram" : "Telegram API responded 403",
  }));
  loadMock.mockResolvedValue([]);
  seedFreshAudits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("collectCloudBoardAlerts - E17, rows at or over 75%", () => {
  it("says nothing while every row is under the line, and reads the board it reports on", async () => {
    loadMock.mockResolvedValue([
      boardRow("tidb-storage", 40 * 1024 ** 2),
      boardRow("render-instance-hours", 300),
      boardRow("vercel-deployments", 18),
    ]);

    const scan = await collectCloudBoardAlerts(AT);

    expect(scan.failure).toBeNull();
    expect(scan.alerts).toEqual([]);
    expect(loadMock).toHaveBeenCalledWith(AT);
  });

  it("reports a crossed row with its own figures - used, limit, percent, feed, reset", async () => {
    // 620 of 750 free instance hours = 82%, floored: the same arithmetic the board's
    // warn flag uses, so the chat can never disagree with the row.
    loadMock.mockResolvedValue([boardRow("render-instance-hours", 620)]);

    const scan = await collectCloudBoardAlerts(AT);

    expect(scan.failure).toBeNull();
    expect(scan.alerts).toHaveLength(1);
    const [alert] = scan.alerts;
    expect(alert.code).toBe("E17");
    expect(alert.key).toBe("render-instance-hours");
    expect(alert.percent).toBe(82);
    expect(alert.line).toContain("Render / Free instance hours");
    expect(alert.line).toContain("82% used (620 of 750 hours, resets monthly)");
    expect(alert.line).toContain("api reading");
    expect(alert.line).toContain("act before 100%");
  });

  it("leaves supplier pools to E14 - one condition must never carry two codes", async () => {
    loadMock.mockResolvedValue([supplierWarnRow]);

    const scan = await collectCloudBoardAlerts(AT);

    expect(scan.failure).toBeNull();
    expect(scan.alerts).toEqual([]);
  });

  it("returns an unreadable board as a failure, never as silence", async () => {
    loadMock.mockRejectedValue(new Error("render unreachable"));

    const scan = await collectCloudBoardAlerts(AT);

    expect(scan.alerts).toEqual([]);
    expect(scan.failure).toBe("render unreachable");
  });
});

describe("collectCloudBoardAlerts - E18, the daily audit slipping", () => {
  it("flags a console reading past 24 h with its age and the moment it was taken", async () => {
    metrics.set("tidb-ru", { used: 416_666, observedAtUnix: AT_UNIX - 26 * HOUR, detail: "416,666 of 50,000,000 RU" });

    const scan = await collectCloudBoardAlerts(AT);

    const e18 = scan.alerts.filter(alert => alert.code === "E18");
    expect(e18).toHaveLength(1);
    expect(e18[0].key).toBe("tidb-ru");
    expect(e18[0].line).toContain("daily audit overdue");
    expect(e18[0].line).toContain("26.0 h old");
    expect(e18[0].line).toContain("recorded 2026-09-29 10:00 UTC");
    expect(e18[0].line).toContain("past the 24 h line");
  });

  it("flags a metric that has never been recorded - an unseen blind spot is not fine", async () => {
    metrics.clear();

    const scan = await collectCloudBoardAlerts(AT);

    const e18 = scan.alerts.filter(alert => alert.code === "E18");
    expect(e18.map(alert => alert.key).sort()).toEqual(["tidb-ru", "vercel-data-transfer"]);
    expect(e18[0].line).toContain("no console reading found");
  });

  it("draws the line at exactly 24 h: a tick under is fresh, a tick over is overdue", async () => {
    metrics.set("tidb-ru", { used: 416_666, observedAtUnix: AT_UNIX - AUDIT_OVERDUE_MS / 1000, detail: "reading" });
    const fresh = await collectCloudBoardAlerts(AT);
    expect(fresh.alerts.filter(alert => alert.code === "E18")).toEqual([]);

    metrics.set("tidb-ru", { used: 416_666, observedAtUnix: AT_UNIX - AUDIT_OVERDUE_MS / 1000 - 1, detail: "reading" });
    const stale = await collectCloudBoardAlerts(AT);
    expect(stale.alerts.filter(alert => alert.code === "E18")).toHaveLength(1);
  });

  it("refuses a reading timestamped ahead of now - a future reading proves nothing", async () => {
    metrics.set("tidb-ru", { used: 416_666, observedAtUnix: AT_UNIX + 2 * HOUR, detail: "reading" });

    const scan = await collectCloudBoardAlerts(AT);

    const e18 = scan.alerts.filter(alert => alert.code === "E18");
    expect(e18).toHaveLength(1);
    expect(e18[0].line).toContain("ahead of now");
  });
});

describe("sendOwnerAlerts - says it once, and proves what it did", () => {
  const renderAlert: OwnerAlert = {
    code: "E17",
    key: "render-instance-hours",
    percent: 82,
    line: "Render / Free instance hours: 82% used (620 of 750 hours, resets monthly) - at or over the 75% line, api reading; act before 100%",
  };

  it("sends one message per code with the board's own numbers, then records what fired", async () => {
    const results = await sendOwnerAlerts([renderAlert], AT);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0]?.[0] as string;
    expect(message).toContain("PRIME quota board [E17]");
    expect(message).toContain(renderAlert.line);
    expect(message).toContain("Prime Dashboard-5000");
    expect(results).toEqual([
      { code: "E17", entries: 1, action: "sent", delivered: true, reason: "accepted by Telegram" },
    ]);
    expect(states.get("alert:E17")?.detail).toBe("render-instance-hours@16");
    expect(states.get("alert:E17")?.observedAtUnix).toBe(AT_UNIX);
  });

  it("suppresses an identical second run instead of repeating the same words", async () => {
    await sendOwnerAlerts([renderAlert], AT);
    const second = await sendOwnerAlerts([renderAlert], AT);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(second[0]?.action).toBe("suppressed");
    expect(second[0]?.reason).toContain("already reported");
    // Suppressed work costs one read and no write: the record is untouched.
    expect(saveMock.mock.calls.filter(call => String((call[0] as BoardObservation).metricKey).startsWith("alert:"))).toHaveLength(1);
  });

  it("speaks again when the quota climbs into the next 5% band", async () => {
    // 82% is band 16 (80-84); the next message comes when it reaches 85, not at 83.
    await sendOwnerAlerts([renderAlert], AT);
    const climbed = await sendOwnerAlerts([{ ...renderAlert, percent: 85 }], AT);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(states.get("alert:E17")?.detail).toBe("render-instance-hours@17");
    expect(climbed[0]?.action).toBe("sent");
  });

  it("re-announces a condition that has stood unchanged for a week", async () => {
    await sendOwnerAlerts([renderAlert], AT);
    const stored = states.get("alert:E17");
    expect(stored).toBeTruthy();
    stored!.observedAtUnix = AT_UNIX - Math.floor(ALERT_REMIND_MS / 1000) - HOUR;

    const later = await sendOwnerAlerts([renderAlert], AT);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(later[0]?.action).toBe("sent");
  });

  it("marks a cleared condition clear, so its return is news again", async () => {
    await sendOwnerAlerts([renderAlert], AT);
    const cleared = await sendOwnerAlerts([], AT);
    expect(cleared).toEqual([]);
    expect(states.get("alert:E17")?.detail).toBe("clear");
    // A code that never fired must not have a state row invented for it.
    expect(states.has("alert:E14")).toBe(false);
    expect(states.has("alert:E18")).toBe(false);

    const returned = await sendOwnerAlerts([renderAlert], AT);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(returned[0]?.action).toBe("sent");
  });

  it("does not record a message Telegram refused, so the next run retries", async () => {
    telegramAccepted = false;
    const failed = await sendOwnerAlerts([renderAlert], AT);
    expect(failed[0]).toMatchObject({ action: "failed", delivered: false });
    expect(failed[0]?.reason).toContain("403");
    expect(failed[0]?.reason).toContain("tries again");
    expect(states.has("alert:E17")).toBe(false);

    telegramAccepted = true;
    const retried = await sendOwnerAlerts([renderAlert], AT);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(retried[0]?.action).toBe("sent");
  });

  it("fails open when the dedup store cannot be read - a missed alert is worse than a repeat", async () => {
    storeUnreachable = true;

    const results = await sendOwnerAlerts([renderAlert], AT);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(results[0]?.action).toBe("sent");
    expect(states.size).toBe(0); // nothing could be written; next run will ask again
  });

  it("keeps each code's history separate: E14 and E17 are two messages, not one", async () => {
    const supplierAlert: OwnerAlert = {
      code: "E14",
      key: "scrappa",
      percent: 84,
      line: "Scrappa quota 84% used (420/500, resets month)",
    };

    const results = await sendOwnerAlerts([renderAlert, supplierAlert], AT);

    expect(sendMock).toHaveBeenCalledTimes(2);
    const messages = sendMock.mock.calls.map(call => String(call[0]));
    expect(messages.some(message => message.includes("[E14]") && message.includes("Scrappa"))).toBe(true);
    expect(messages.some(message => message.includes("[E17]") && message.includes("Render"))).toBe(true);
    expect(results.map(result => result.code).sort()).toEqual(["E14", "E17"]);
    expect(states.has("alert:E14")).toBe(true);
    expect(states.has("alert:E17")).toBe(true);
  });

  it("still reports the send as sent when only the dedup record failed - and says so", async () => {
    saveThrowsOnce = true;

    const results = await sendOwnerAlerts([renderAlert], AT);

    expect(results[0]?.action).toBe("sent");
    expect(results[0]?.delivered).toBe(true);
    expect(results[0]?.reason).toContain("dedup state not recorded");
    expect(results[0]?.reason).toContain("may repeat");
  });
});
