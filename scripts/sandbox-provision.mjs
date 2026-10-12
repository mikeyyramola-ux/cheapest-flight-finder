#!/usr/bin/env node
/**
 * SANDBOX PROVISIONING - run this ONCE, locally, before the sandbox test.
 *
 * WHY THIS EXISTS
 * ---------------
 * PayPal's Developer Dashboard has no UI for creating a billing plan or a
 * webhook. Both are API-only. Rather than walk you through an API explorer that
 * hides half the fields, this does the three calls in order and prints exactly
 * the two IDs you need to paste into Vercel.
 *
 * SAFETY
 * ------
 * The base URL is HARDCODED to the sandbox host. This script cannot touch your
 * live account or take real money, whatever environment variables are set.
 * Your secret is read from your own terminal and is never printed or written
 * to disk.
 *
 * USAGE
 * -----
 *   set PAYPAL_CLIENT_ID=...        (sandbox app -> Client ID)
 *   set PAYPAL_CLIENT_SECRET=...    (sandbox app -> Secret)
 *   node scripts/sandbox-provision.mjs
 *
 * Optionally pass your webhook URL:
 *   node scripts/sandbox-provision.mjs https://fareloop.in/api/paypal/webhook
 */

// Hardcoded on purpose. This script must never be able to reach live PayPal.
const BASE = "https://api-m.sandbox.paypal.com";

const WEBHOOK_URL = process.argv[2] ?? "https://fareloop.in/api/paypal/webhook";

// The events fareloop's handler actually reads (server/paypal.ts). Subscribing to
// fewer than these means an activation can arrive with nowhere to go.
const EVENTS = [
  "BILLING.SUBSCRIPTION.ACTIVATED", // the one that grants premium
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.REFUNDED",
];

async function token() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) {
    console.error(
      "\n[STOP] PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set.\n" +
        "       Use the SANDBOX app's credentials (dashboard -> Sandbox mode -> your app),\n" +
        "       not the live ones. This script never reads or prints the secret value.\n"
    );
    process.exit(1);
  }

  const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    console.error(
      "\n[STOP] Sandbox authentication failed (HTTP " + res.status + ").\n" +
        "       Most likely the credentials are LIVE ones. Check the Sandbox/Live\n" +
        "       toggle at the top of Apps & Credentials - it must say Sandbox.\n"
    );
    process.exit(1);
  }

  const data = await res.json();
  return data.access_token;
}

async function call(t, path, options) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`\n[STOP] ${options.method ?? "GET"} ${path} failed (HTTP ${res.status})`);
    console.error("       " + JSON.stringify(body).slice(0, 400) + "\n");
    process.exit(1);
  }
  return body;
}

async function main() {
  console.log("\nFareloop - PayPal SANDBOX provisioning");
  console.log("Host: " + BASE + "  (hardcoded; cannot reach live)\n");

  const t = await token();
  console.log("[1/3] Authenticated to sandbox.");

  // A product is the container a plan hangs off. Plans cannot exist without one.
  const product = await call(t, "/v1/catalogs/products", {
    method: "POST",
    body: JSON.stringify({
      name: "Fareloop Premium",
      description: "Fareloop Premium monthly subscription",
      type: "SERVICE",
      category: "SOFTWARE",
    }),
  });
  console.log(`[2/3] Product created: ${product.id}`);

  // The plan is what actually charges 9.99 USD every month, forever.
  const plan = await call(t, "/v1/billing/plans", {
    method: "POST",
    body: JSON.stringify({
      product_id: product.id,
      name: "Fareloop Premium",
      description: "Premium monthly",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0, // 0 = renew until cancelled
          pricing_scheme: { fixed_price: { value: "9.99", currency_code: "USD" } },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 0,
      },
    }),
  });
  console.log(`[3/3] Plan created: ${plan.id} @ 9.99 USD / month`);

  const webhook = await call(t, "/v1/notifications/webhooks", {
    method: "POST",
    body: JSON.stringify({
      url: WEBHOOK_URL,
      event_types: EVENTS.map(name => ({ name })),
    }),
  });
  console.log(`      Webhook created for ${WEBHOOK_URL}`);
  console.log(`      Webhook ID: ${webhook.id}`);
  console.log(`      Events: ${EVENTS.length} subscribed\n`);

  console.log("=".repeat(72));
  console.log("PASTE THESE TWO INTO VERCEL (see runbook step 5):");
  console.log("=".repeat(72));
  console.log("\n  PAYPAL_PREMIUM_PLAN_ID   = " + plan.id);
  console.log("  PAYPAL_WEBHOOK_ID        = " + webhook.id + "\n");
  console.log("Keep the tab open - you will also need the sandbox Client ID and");
  console.log("Secret from the app page for step 5.\n");
}

main().catch(err => {
  console.error("\n[STOP] " + err.message + "\n");
  process.exit(1);
});
