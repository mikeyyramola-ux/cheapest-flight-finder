import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PROPOSAL 18 (PayPal half).
 *
 * These three cases are the ones that used to fall through to a bare
 * `return { verified: true }` - a refund or a failed payment authenticated
 * successfully, matched no branch, and vanished without a log line. The tests
 * exist so that "silently accepted" can never quietly come back.
 */
const mocks = vi.hoisted(() => ({
  getUserBySubscriptionId: vi.fn(),
  updateUserPayPalSubscription: vi.fn(),
  deliverTelegram: vi.fn(),
}));

vi.mock("./db", () => ({
  getUserBySubscriptionId: mocks.getUserBySubscriptionId,
  updateUserPayPalSubscription: mocks.updateUserPayPalSubscription,
}));

vi.mock("./telegram", () => ({ deliverTelegram: mocks.deliverTelegram }));

vi.stubEnv("PAYPAL_WEBHOOK_ID", "WEBHOOK-TEST-ID");
vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");

// Two endpoints share `fetch`: the token exchange and the signature check.
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      return { ok: true, json: async () => ({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 }) };
    }
    return { ok: true, json: async () => ({ verification_status: "SUCCESS" }) };
  })
);

const { handlePayPalWebhook } = await import("./paypal");

const HEADERS = {
  "paypal-transmission-id": "TX-1",
  "paypal-transmission-time": "2026-10-04T00:00:00Z",
  "paypal-cert-url": "https://api-m.sandbox.paypal.com/cert.pem",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "sig",
};

function webhook(eventType: string, resource: Record<string, unknown>) {
  return handlePayPalWebhook(
    Buffer.from(JSON.stringify({ event_type: eventType, resource })),
    HEADERS
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserBySubscriptionId.mockResolvedValue({ id: 42, paypalSubscriptionId: "I-TEST" });
  mocks.updateUserPayPalSubscription.mockResolvedValue(true);
  mocks.deliverTelegram.mockResolvedValue({
    channel: "Telegram",
    message: "",
    delivered: true,
    reason: "accepted by Telegram",
  });
});

describe("handlePayPalWebhook - payment failures", () => {
  it("marks the subscription past_due when a payment fails", async () => {
    const result = await webhook("BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
      id: "I-TEST",
      custom_id: "99",
    });

    expect(result.verified).toBe(true);
    expect(mocks.getUserBySubscriptionId).toHaveBeenCalledWith("paypal", "I-TEST");
    expect(mocks.updateUserPayPalSubscription).toHaveBeenCalledWith({
      userId: 42,
      subscriptionId: "I-TEST",
      status: "past_due",
    });
    expect(mocks.deliverTelegram).toHaveBeenCalledTimes(1);
  });

  it("still reports verified when no user can be matched", async () => {
    mocks.getUserBySubscriptionId.mockResolvedValue(undefined);

    const result = await webhook("BILLING.SUBSCRIPTION.PAYMENT.FAILED", { id: "I-UNKNOWN" });

    expect(result.verified).toBe(true);
    expect(mocks.updateUserPayPalSubscription).not.toHaveBeenCalled();
    // The owner is still told, because an unattributed failure is the one most
    // likely to be missed entirely.
    expect(mocks.deliverTelegram).toHaveBeenCalledTimes(1);
  });
});

describe("handlePayPalWebhook - refunds", () => {
  it("cancels access when a sale is refunded", async () => {
    const result = await webhook("PAYMENT.SALE.REFUNDED", {
      billing_agreement_id: "I-TEST",
      custom_id: "42",
    });

    expect(result.verified).toBe(true);
    expect(mocks.updateUserPayPalSubscription).toHaveBeenCalledWith({
      userId: 42,
      subscriptionId: "I-TEST",
      status: "canceled",
    });
    expect(mocks.deliverTelegram).toHaveBeenCalledTimes(1);
  });
});

describe("handlePayPalWebhook - never silently swallow again", () => {
  it("acknowledges an unhandled event but flags it instead of hiding it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await webhook("PAYMENT.SALE.COMPLETED", { id: "I-TEST" });

    expect(result.verified).toBe(true);
    expect(result).toMatchObject({ unhandled: true });
    expect(warn).toHaveBeenCalledWith("[PayPal] UNHANDLED webhook event", "PAYMENT.SALE.COMPLETED");
    expect(mocks.updateUserPayPalSubscription).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
