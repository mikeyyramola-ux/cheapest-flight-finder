import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CREATED is not ACTIVATED.
 *
 * PayPal fires BILLING.SUBSCRIPTION.CREATED the instant a subscription record
 * exists - which is the moment the buyer has been handed the approval page and
 * may simply never return. BILLING.SUBSCRIPTION.ACTIVATED fires only once PayPal
 * has approved the mandate and collected the first payment.
 *
 * Both were recorded as `status: "active"`, so a signed-in customer who started
 * a checkout and abandoned it had an "active" subscription written to their
 * users row, and the owner was paged that a subscription "is active" for someone
 * who had paid nothing.
 *
 * The paywall was never fooled: isActiveSubscriber asks PayPal for the live
 * status and never reads this column. That is why the defect shipped unnoticed.
 * But a column that lies about whether money changed hands is a trap for the
 * next reader of subscriptionStatus, so it is recorded honestly here.
 *
 * PayPal is faked only at its two network edges (token exchange and signature
 * verification). Every fareloop decision under test is real.
 */

const mocks = vi.hoisted(() => ({
  getUserByEmail: vi.fn(),
  getUserBySubscriptionId: vi.fn(),
  updateUserPayPalSubscription: vi.fn(),
  deliverTelegram: vi.fn(),
}));

vi.mock("./db", () => ({
  getUserByEmail: mocks.getUserByEmail,
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
  "paypal-transmission-time": "2026-10-11T00:00:00Z",
  "paypal-cert-url": "https://api-m.paypal.com/cert.pem",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-transmission-sig": "sig",
};

function webhook(eventType: string, resource: Record<string, unknown>) {
  return handlePayPalWebhook(Buffer.from(JSON.stringify({ event_type: eventType, resource })), HEADERS);
}

function persistedStatus(): string | undefined {
  return mocks.updateUserPayPalSubscription.mock.calls[0]?.[0]?.status as string | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no user is discoverable by any route. Individual tests opt in to a
  // resolvable customer, so "nothing resolves" is the true default rather than an
  // accident of a fixture that happens to return user 42.
  mocks.getUserByEmail.mockResolvedValue(undefined);
  mocks.getUserBySubscriptionId.mockResolvedValue(undefined);
  mocks.updateUserPayPalSubscription.mockResolvedValue(true);
  mocks.deliverTelegram.mockResolvedValue({
    channel: "Telegram",
    message: "",
    delivered: true,
    reason: "accepted by Telegram",
  });
});

describe("CREATED (buyer shown the approval page, has not paid)", () => {
  it("records the subscription as pending, NOT active", async () => {
    await webhook("BILLING.SUBSCRIPTION.CREATED", { id: "I-CREATED00001", custom_id: "4242" });

    expect(persistedStatus()).toBe("pending");
  });

  it("does not describe the event as a paid one", async () => {
    const result = await webhook("BILLING.SUBSCRIPTION.CREATED", { id: "I-CREATED00002", custom_id: "4242" });

    expect(result.paid).toBe(false);
  });

  it("still attaches the subscription id, so the account is linked on later approval", async () => {
    // Abandoning a checkout should not lose the association - it simply must not
    // claim payment.
    await webhook("BILLING.SUBSCRIPTION.CREATED", { id: "I-CREATED00003", custom_id: "4242" });

    expect(mocks.updateUserPayPalSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "I-CREATED00003", userId: 4242 })
    );
  });
});

describe("ACTIVATED (PayPal approved the mandate and took the first payment)", () => {
  it("records the subscription as active", async () => {
    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-ACTIVATED0001", custom_id: "4242" });

    expect(persistedStatus()).toBe("active");
  });

  it("describes the event as a paid one", async () => {
    const result = await webhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-ACTIVATED0002", custom_id: "4242" });

    expect(result.paid).toBe(true);
  });
});

describe("the distinction cannot be collapsed back", () => {
  it("writes two DIFFERENT statuses for the same subscription id", async () => {
    // The regression itself: if someone re-unifies the branches, this is what
    // stops them. Same id, same user - only the event differs.
    const id = "I-SAMEID00000001";

    await webhook("BILLING.SUBSCRIPTION.CREATED", { id, custom_id: "4242" });
    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", { id, custom_id: "4242" });

    const statuses = mocks.updateUserPayPalSubscription.mock.calls.map(c => c[0]?.status);
    expect(statuses).toEqual(["pending", "active"]);
  });

  it("never writes 'active' for any event other than ACTIVATED", async () => {
    // Sweep the whole billing family, so a future branch cannot quietly reintroduce
    // the lie under a different event name.
    const nonPaidEvents = [
      "BILLING.SUBSCRIPTION.CREATED",
      "BILLING.SUBSCRIPTION.CANCELLED",
      "BILLING.SUBSCRIPTION.SUSPENDED",
      "PAYMENT.SALE.REFUNDED",
      "PAYMENT.SALE.DENIED",
    ];

    for (const eventType of nonPaidEvents) {
      await webhook(eventType, { id: "I-SWEEP000000001", custom_id: "4242", billing_agreement_id: "I-SWEEP000000001" });
      if (mocks.updateUserPayPalSubscription.mock.calls.length) {
        expect(persistedStatus(), `event=${eventType}`).not.toBe("active");
      }
      vi.clearAllMocks();
      mocks.updateUserPayPalSubscription.mockResolvedValue(true);
      mocks.deliverTelegram.mockResolvedValue({ channel: "Telegram", message: "", delivered: true, reason: "ok" });
    }
  });

  it("still refuses to attribute an event with no resolvable user", async () => {
    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-ORPHAN00000001", custom_id: "demo" });

    expect(mocks.updateUserPayPalSubscription).not.toHaveBeenCalled();
    expect(mocks.deliverTelegram).toHaveBeenCalledWith(expect.stringContaining("no user to attribute"));
  });
});
