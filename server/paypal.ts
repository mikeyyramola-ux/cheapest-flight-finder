import { updateUserPayPalSubscription } from "./db";

export const premiumPlanPayPal = {
  name: "Premium Member (PayPal)",
  price: 9.99,
  interval: "month",
  features: ["Instant price-drop alerts", "Historical price trends", "Unlimited route tracking"],
};

const PAYPAL_API_BASE = process.env.PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID ?? "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET ?? "";
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID ?? "";
const PAYPAL_PREMIUM_PLAN_ID = process.env.PAYPAL_PREMIUM_PLAN_ID ?? ""; // Billing plan ID from PayPal dashboard

interface PayPalTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

let paypalTokenCache: { token: string; expiresAt: number } | null = null;

async function getPayPalAccessToken(): Promise<string> {
  if (paypalTokenCache && Date.now() < paypalTokenCache.expiresAt) {
    return paypalTokenCache.token;
  }
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal token error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as PayPalTokenResponse;
  paypalTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function paypalFetch(path: string, options: RequestInit = {}) {
  const token = await getPayPalAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID(),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function createPayPalCheckout(input: {
  origin: string;
  userId?: number;
  email?: string | null;
  name?: string | null;
}) {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_PREMIUM_PLAN_ID) {
    return { mode: "demo" as const, url: `/paywall?checkout=demo&route=${encodeURIComponent(input.origin)}&provider=paypal`, subscriptionId: "" };
  }

  const token = await getPayPalAccessToken();

  // Create a subscription via PayPal Billing API
  const subscription = await paypalFetch("/v1/billing/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      plan_id: PAYPAL_PREMIUM_PLAN_ID,
      application_context: {
        brand_name: "Fareloop",
        locale: "en-US",
        landing_page: "BILLING",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: `${process.env.APP_ORIGIN ?? "https://fareloop.in"}/?checkout=success&provider=paypal`,
        cancel_url: `${process.env.APP_ORIGIN ?? "https://fareloop.in"}/?checkout=cancelled&provider=paypal`,
      },
      subscriber: {
        email_address: input.email ?? undefined,
        name: input.name ? { given_name: input.name.split(" ")[0], surname: input.name.split(" ").slice(1).join(" ") } : undefined,
      },
      custom_id: input.userId?.toString() ?? "demo",
    }),
  });

  const approveLink = subscription.links?.find((l: any) => l.rel === "approve")?.href;
  // The client needs this ID: it is the handle it later hands back to
  // billing.verifyPayPal so a payer can prove they actually subscribed.
  return { mode: "paypal" as const, url: approveLink ?? "", subscriptionId: String(subscription.id ?? "") };
}

/**
 * Ask PayPal, directly and server-side, whether a subscription is still active.
 *
 * This deliberately does NOT consult a database. It is the one piece of state we
 * can verify without a user store, and it means a paying customer's access does
 * not depend on infrastructure we have not provisioned yet.
 */
export async function getPayPalSubscription(subscriptionId: string) {
  // PayPal subscription IDs look like "I-1AB23C4D5E6F7G8H9I0J". Validate first, before
  // anything else, so malformed input never reaches the API path - this must not be
  // usable as an open proxy against PayPal on our credentials.
  if (!/^I-[A-Z0-9]{5,50}$/i.test(subscriptionId)) throw new Error("Malformed subscription id");
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error("PayPal is not configured");
  return paypalFetch(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function handlePayPalWebhook(
  payload: Buffer,
  headers: Record<string, string | string[] | undefined>
) {
  if (!PAYPAL_WEBHOOK_ID) return { verified: false, reason: "PayPal webhook ID not configured" };

  const transmissionId = headers["paypal-transmission-id"] as string;
  const transmissionTime = headers["paypal-transmission-time"] as string;
  const certUrl = headers["paypal-cert-url"] as string;
  const authAlgo = headers["paypal-auth-algo"] as string;
  const transmissionSig = headers["paypal-transmission-sig"] as string;
  const webhookId = PAYPAL_WEBHOOK_ID;

  // Verify webhook signature using PayPal's SDK approach (simplified - in production use @paypal/webhook-verifier)
  const verifyRes = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getPayPalAccessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: JSON.parse(payload.toString()),
    }),
  });

  const verifyData = await verifyRes.json();
  if (verifyData.verification_status !== "SUCCESS") {
    return { verified: false, reason: "Webhook signature verification failed" };
  }

  const event = JSON.parse(payload.toString());

  // Handle billing subscription events
  if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED" || event.event_type === "BILLING.SUBSCRIPTION.CREATED") {
    const subscription = event.resource;
    const userId = Number(subscription.custom_id);
    const subscriptionId = subscription.id;
    if (Number.isInteger(userId) && userId > 0) {
      await updateUserPayPalSubscription({ userId, subscriptionId, status: "active" });
    }
    return { verified: true, type: event.event_type };
  }

  if (event.event_type === "BILLING.SUBSCRIPTION.CANCELLED" || event.event_type === "BILLING.SUBSCRIPTION.SUSPENDED") {
    const subscription = event.resource;
    const userId = Number(subscription.custom_id);
    const subscriptionId = subscription.id;
    if (Number.isInteger(userId) && userId > 0) {
      await updateUserPayPalSubscription({ userId, subscriptionId, status: "canceled" });
    }
    return { verified: true, type: event.event_type };
  }

  return { verified: true, type: event.event_type };
}