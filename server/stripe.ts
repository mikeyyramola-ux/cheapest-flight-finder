import Stripe from "stripe";
import { updateUserStripeSubscription } from "./db";

export const premiumPlan = {
  name: "Premium Member",
  price: 9.99,
  interval: "month",
  features: ["Instant price-drop alerts", "Historical price trends", "Unlimited route tracking", "Priority deal scans"],
};

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export async function createPremiumCheckout(input: { origin: string; userId?: number; email?: string | null; name?: string | null }) {
  if (!stripe || !process.env.STRIPE_PREMIUM_PRICE_ID) {
    return { mode: "demo" as const, url: `/paywall?checkout=demo&route=${encodeURIComponent(input.origin)}` };
  }
  const origin = process.env.APP_ORIGIN ?? "https://faredrop-snowy.vercel.app";
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: input.email ?? undefined,
    client_reference_id: input.userId?.toString(),
    metadata: { user_id: input.userId?.toString() ?? "demo", customer_email: input.email ?? "", customer_name: input.name ?? "" },
    line_items: [{ price: process.env.STRIPE_PREMIUM_PRICE_ID ?? "", quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancelled`,
  });
  return { mode: "stripe" as const, url: session.url };
}

export async function handleStripeWebhook(payload: Buffer, signature?: string) {
  if (!stripe || !signature) return { verified: false, mode: "demo" as const, reason: "Stripe keys are not configured" };
  const event = stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET ?? "");
  if (event.id.startsWith("evt_test_")) return { verified: true, mode: "stripe" as const };
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = Number(session.metadata?.user_id);
    const customerId = typeof session.customer === "string" ? session.customer : null;
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
    const persisted = Number.isInteger(userId) && userId > 0
      ? await updateUserStripeSubscription({ userId, customerId, subscriptionId, status: "active" })
      : false;
    console.info("[Stripe] Premium checkout completed", { eventId: event.id, userId: session.metadata?.user_id, customerId, subscriptionId, persisted });
    return { verified: true, mode: "stripe" as const, type: event.type, persisted };
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;
    const userId = Number(subscription.metadata?.user_id);
    const customerId = typeof subscription.customer === "string" ? subscription.customer : null;
    const persisted = Number.isInteger(userId) && userId > 0
      ? await updateUserStripeSubscription({ userId, customerId, subscriptionId: subscription.id, status: event.type.endsWith("deleted") ? "canceled" : subscription.status })
      : false;
    console.info("[Stripe] Subscription lifecycle update", { eventId: event.id, userId: subscription.metadata?.user_id, subscriptionId: subscription.id, status: event.type.endsWith("deleted") ? "canceled" : subscription.status, persisted });
    return { verified: true, mode: "stripe" as const, type: event.type, persisted };
  }
  return { verified: true, mode: "stripe" as const, type: event.type };
}
