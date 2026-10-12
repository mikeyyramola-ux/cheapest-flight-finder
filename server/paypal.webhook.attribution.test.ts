import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ATTRIBUTION MUST NOT REST ON A SINGLE FIELD.
 *
 * The webhook handler identified the customer solely by `Number(resource.custom_id)`.
 * `custom_id` is the value we stamp onto the subscription at checkout, so it is the
 * natural choice - but it is the one field in PayPal's subscription payload we do
 * not control. PayPal's documented payload leads with `id`, `plan_id`, `subscriber`
 * and `billing_info`, and captures of real subscription events do not consistently
 * show `custom_id`.
 *
 * If it were ever absent, `Number(undefined)` is NaN, `Number.isInteger(NaN)` is
 * false, and the handler fell through to paging the owner with "no user to
 * attribute it to". The customer would be CHARGED and receive nothing, on the one
 * code path that only runs when somebody actually pays. Worst of all: the paywall
 * would still be fine, so every other test would keep passing. The failure would
 * be invisible until a real buyer completed a real purchase.
 *
 * These tests drive the real handler with the field genuinely ABSENT, because that
 * is the case nobody writes a test for - it is the one nobody types into.
 *
 * Only PayPal's two network edges (token exchange, signature verification) are
 * faked. Every fareloop decision under test is real.
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

/** A resource shaped as PayPal documents it: NO custom_id anywhere. */
function paypalShapedResource(extra: Record<string, unknown> = {}) {
  return {
    id: "I-SUBSCRIPTION0001",
    plan_id: "P-PLAN0000000001",
    start_time: "2026-10-11T00:00:00Z",
    quantity: "1",
    subscriber: { email_address: "customer@example.com", name: { given_name: "Ada", surname: "Lovelace" } },
    billing_info: { outstanding_balance: { currency_code: "USD", value: "0.00" } },
    create_time: "2026-10-11T00:00:00Z",
    status: "ACTIVE",
    ...extra,
  };
}

function webhook(eventType: string, resource: Record<string, unknown>) {
  return handlePayPalWebhook(Buffer.from(JSON.stringify({ event_type: eventType, resource })), HEADERS);
}

function attributedUserId(): number | undefined {
  return mocks.updateUserPayPalSubscription.mock.calls[0]?.[0]?.userId as number | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserByEmail.mockResolvedValue(undefined);
  mocks.getUserBySubscriptionId.mockResolvedValue(undefined);
  mocks.updateUserPayPalSubscription.mockResolvedValue(true);
  mocks.deliverTelegram.mockResolvedValue({ channel: "Telegram", message: "", delivered: true, reason: "ok" });
});

describe("custom_id is absent - the case nobody tests", () => {
  it("still attributes an ACTIVATED event, using the subscriber's email", async () => {
    // The defect itself. Resource shaped exactly as PayPal documents it.
    mocks.getUserByEmail.mockResolvedValue({ id: 777, email: "customer@example.com" });

    const result = await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource());

    expect(attributedUserId()).toBe(777);
    expect(result.attributed).toBe(true);
  });

  it("marks that customer's subscription active once attributed", async () => {
    mocks.getUserByEmail.mockResolvedValue({ id: 777, email: "customer@example.com" });

    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource());

    expect(mocks.updateUserPayPalSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 777, subscriptionId: "I-SUBSCRIPTION0001", status: "active" })
    );
  });

  it("retries the email lowercased when the exact match fails", async () => {
    // PayPal normalises email casing, but the column is compared with `eq`, which
    // is case-sensitive. A customer who signed up as Ada@Example.com must still be
    // found when PayPal reports ada@example.com.
    mocks.getUserByEmail.mockImplementation(async (email: string) =>
      email === "ada@example.com" ? { id: 888, email } : undefined
    );

    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource({
      subscriber: { email_address: "Ada@Example.com" },
    }));

    expect(attributedUserId()).toBe(888);
  });

  it("does not query twice when the email matches exactly", async () => {
    mocks.getUserByEmail.mockResolvedValue({ id: 777, email: "customer@example.com" });

    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource());

    expect(mocks.getUserByEmail).toHaveBeenCalledTimes(1);
  });

  it("falls back to a subscription already recorded against an account", async () => {
    // No custom_id, and the email does not resolve - but we have seen this
    // subscription before, so it is already known to belong to somebody.
    mocks.getUserBySubscriptionId.mockResolvedValue({ id: 999, paypalSubscriptionId: "I-SUBSCRIPTION0001" });

    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource({ subscriber: {} }));

    expect(attributedUserId()).toBe(999);
  });
});

describe("custom_id is present - the fast path still wins", () => {
  it("attributes by custom_id without consulting the database", async () => {
    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource({ custom_id: "4242" }));

    expect(attributedUserId()).toBe(4242);
    expect(mocks.getUserByEmail).not.toHaveBeenCalled();
    expect(mocks.getUserBySubscriptionId).not.toHaveBeenCalled();
  });

  it("falls through when custom_id is the non-numeric 'demo' an anonymous checkout writes", async () => {
    // createPayPalCheckout stamps "demo" when there is no signed-in user. That is
    // not a user id, and must not be mistaken for one - it should fall through to
    // the email, which will not resolve either, so the owner is alerted.
    await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource({ custom_id: "demo" }));

    expect(attributedUserId()).toBeUndefined();
    expect(mocks.getUserByEmail).toHaveBeenCalledWith("customer@example.com");
  });

  it("falls through when custom_id is zero or negative", async () => {
    for (const bad of [0, -1]) {
      vi.clearAllMocks();
      mocks.getUserByEmail.mockResolvedValue({ id: 555, email: "customer@example.com" });
      mocks.updateUserPayPalSubscription.mockResolvedValue(true);
      mocks.deliverTelegram.mockResolvedValue({ channel: "Telegram", message: "", delivered: true, reason: "ok" });

      await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource({ custom_id: String(bad) }));

      expect(attributedUserId(), `custom_id=${bad}`).toBe(555);
    }
  });
});

describe("genuinely unattributable - the owner must still be told", () => {
  it("pages the owner when nothing identifies a customer", async () => {
    const result = await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource({ subscriber: {} }));

    expect(mocks.updateUserPayPalSubscription).not.toHaveBeenCalled();
    expect(mocks.deliverTelegram).toHaveBeenCalledWith(expect.stringContaining("no user to attribute"));
    expect(result.attributed).toBe(false);
  });

  it("does not silently succeed - the response says it was unattributed", async () => {
    const result = await webhook("BILLING.SUBSCRIPTION.ACTIVATED", paypalShapedResource({ subscriber: {} }));

    expect(result.verified).toBe(true); // the signature WAS valid
    expect(result.attributed).toBe(false); // but no customer was identified
  });
});
