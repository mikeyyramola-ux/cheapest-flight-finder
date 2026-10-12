import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Alert ROUTING - the recipient, not the delivery.
 *
 * Before this change deliverTelegram took no recipient at all and read
 * TELEGRAM_CHAT_ID unconditionally, so EVERY subscriber's price drop landed in the
 * OWNER's Telegram. The chat id captured at sign-up (GO 167) was stored and then
 * never read.
 *
 * These tests assert the address on the wire: what chat_id actually goes into the
 * Telegram API request. That is the whole point of the change, and asserting
 * `delivered:true` alone would have passed against the old, wrong behaviour.
 */

const ownerChat = "8063753263";
const customerChat = "99887766";

const db = vi.hoisted(() => ({ getTelegramChatIdForUser: vi.fn() }));

vi.mock("./db", async (importOriginal) => ({
  // Keep every real export (price-store needs getDb) and stub only the lookup,
  // so this file cannot pass by breaking something else.
  ...(await importOriginal<typeof import("./db")>()),
  getTelegramChatIdForUser: db.getTelegramChatIdForUser,
}));

const { sendPriceDropNotification } = await import("./flight-data");

/** A route owned by a customer, which is the case that used to misroute. */
const customerRoute = {
  id: "route-customer-1",
  origin: "JFK",
  destination: "LHR",
  departDate: "2026-11-01",
  returnDate: "2026-11-08",
  currentPrice: 410,
  targetPrice: 400,
  alertChannel: "Telegram" as const,
  userId: 4242,
};

function mockTelegram(response: { ok: boolean; status?: number; description?: string }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? 200,
    json: async () => (response.ok ? { ok: true, result: { message_id: 1 } } : { ok: false, description: response.description }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentChatId(fetchMock: ReturnType<typeof vi.fn>): string {
  const init = fetchMock.mock.calls[0]?.[1] as { body: string };
  return (JSON.parse(init.body) as { chat_id: string }).chat_id;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "configured");
  vi.stubEnv("TELEGRAM_CHAT_ID", ownerChat);
});

describe("alert routing - the customer gets their own alert", () => {
  it("addresses the message to the CUSTOMER's chat, not the owner's", async () => {
    db.getTelegramChatIdForUser.mockResolvedValueOnce(customerChat);
    const fetchMock = mockTelegram({ ok: true });

    const result = await sendPriceDropNotification(customerRoute, 22);

    expect(result.delivered).toBe(true);
    expect(db.getTelegramChatIdForUser).toHaveBeenCalledWith(4242);
    expect(sentChatId(fetchMock)).toBe(customerChat);
    expect(sentChatId(fetchMock)).not.toBe(ownerChat);
  });

  it("falls back to the owner's chat when the customer has no stored id", async () => {
    // No chat id captured at sign-up: the alert must still go somewhere rather
    // than vanish, and the owner is the deliberate fallback.
    db.getTelegramChatIdForUser.mockResolvedValueOnce(null);
    const fetchMock = mockTelegram({ ok: true });

    const result = await sendPriceDropNotification(customerRoute, 22);

    expect(result.delivered).toBe(true);
    expect(sentChatId(fetchMock)).toBe(ownerChat);
  });

  it("reports undelivered when Telegram refuses a customer who never pressed Start", async () => {
    // A bot may only message a chat that started a conversation with it. That is a
    // 403, and it must never be reported as a successful delivery.
    db.getTelegramChatIdForUser.mockResolvedValueOnce(customerChat);
    mockTelegram({ ok: false, status: 403, description: "bot was blocked by the user" });

    const result = await sendPriceDropNotification(customerRoute, 22);

    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/403/);
  });

  it("does not look up a recipient for WhatsApp, which is still a placeholder", async () => {
    db.getTelegramChatIdForUser.mockResolvedValue(null);

    const result = await sendPriceDropNotification({ ...customerRoute, alertChannel: "WhatsApp" as const }, 22);

    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/not implemented/i);
    expect(db.getTelegramChatIdForUser).not.toHaveBeenCalled();
  });

  it("still routes an owner-owned route (no userId) to the owner", async () => {
    // Legacy rows carry no userId. They must keep working, not start failing.
    db.getTelegramChatIdForUser.mockResolvedValueOnce(null);
    const fetchMock = mockTelegram({ ok: true });

    await sendPriceDropNotification({ ...customerRoute, userId: null }, 22);

    expect(sentChatId(fetchMock)).toBe(ownerChat);
  });
});
