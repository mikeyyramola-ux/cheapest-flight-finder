/**
 * ASK 103 - throttle + forwarding rules of server/alerts.ts.
 *
 * New file, no existing test is modified. Nothing here reaches the network:
 * ./telegram is mocked, and the throttle decision is tested through its
 * injectable clock and state map, never through real time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAGE_THROTTLE_MS, shouldPage, warnAndPage } from "./alerts";

const telegram = vi.hoisted(() => ({
  deliverTelegram: vi.fn(async (message: string) => ({
    channel: "Telegram" as const,
    message,
    delivered: true,
    reason: "accepted by Telegram",
  })),
}));

vi.mock("./telegram", () => telegram);

const HOUR = 60 * 60 * 1000;

describe("shouldPage", () => {
  it("pages the first occurrence of a key", () => {
    const seen = new Map<string, number>();
    expect(shouldPage("db:connect", 1_000, HOUR, seen)).toBe(true);
  });

  it("refuses every repeat inside the throttle window", () => {
    const seen = new Map<string, number>();
    expect(shouldPage("db:connect", 0, HOUR, seen)).toBe(true);
    expect(shouldPage("db:connect", HOUR - 1, HOUR, seen)).toBe(false);
    expect(shouldPage("db:connect", 1, HOUR, seen)).toBe(false);
  });

  it("pages again once the window has fully elapsed", () => {
    const seen = new Map<string, number>();
    expect(shouldPage("db:connect", 0, HOUR, seen)).toBe(true);
    expect(shouldPage("db:connect", HOUR, HOUR, seen)).toBe(true);
  });

  it("keeps each key's window independent", () => {
    const seen = new Map<string, number>();
    expect(shouldPage("auth:missing-cookie", 0, HOUR, seen)).toBe(true);
    expect(shouldPage("db:connect", 0, HOUR, seen)).toBe(true);
    expect(shouldPage("auth:missing-cookie", 1, HOUR, seen)).toBe(false);
  });
});

describe("warnAndPage", () => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChat = process.env.TELEGRAM_CHAT_ID;

  beforeEach(() => {
    telegram.deliverTelegram.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = savedChat;
  });

  it("keeps the console line exactly as it was, credentials or not", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    warnAndPage("db:connect", "[Database] Failed to connect:", new Error("down"));
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]).toEqual([
      "[Database] Failed to connect:",
      new Error("down"),
    ]);
    expect(telegram.deliverTelegram).not.toHaveBeenCalled();
  });

  it("pages once per key per hour and never floods the chat", () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-for-test";
    process.env.TELEGRAM_CHAT_ID = "chat-for-test";
    warnAndPage("alerts:test-flood", "[Database] Cannot upsert user: database not available");
    warnAndPage("alerts:test-flood", "[Database] Cannot upsert user: database not available");
    warnAndPage("alerts:test-flood", "[Database] Cannot upsert user: database not available");
    expect(telegram.deliverTelegram).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(vi.mocked(console.warn).mock.calls[0]).toEqual([
      "[Database] Cannot upsert user: database not available",
    ]);
  });

  it("gives each key its own slot", () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-for-test";
    process.env.TELEGRAM_CHAT_ID = "chat-for-test";
    warnAndPage("alerts:test-key-a", "first");
    warnAndPage("alerts:test-key-b", "second");
    expect(telegram.deliverTelegram).toHaveBeenCalledTimes(2);
  });

  it("reports a refused page instead of claiming success", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token-for-test";
    process.env.TELEGRAM_CHAT_ID = "chat-for-test";
    telegram.deliverTelegram.mockResolvedValueOnce({
      channel: "Telegram",
      message: "",
      delivered: false,
      reason: "Telegram API responded 403",
    });
    warnAndPage("alerts:test-refusal", "payload");
    await vi.waitFor(() => {
      expect(vi.mocked(console.warn).mock.calls.some(call =>
        String(call[0]).includes("not delivered: Telegram API responded 403")
      )).toBe(true);
    });
  });
});
