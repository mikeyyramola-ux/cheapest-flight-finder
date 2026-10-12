#!/usr/bin/env node
/**
 * FARELOOP SANDBOX TEST ORCHESTRATOR
 * ==================================
 * Removes every step of the sandbox test that does not require a PayPal login.
 * Two logins remain yours alone, permanently - I will never ask you to share them:
 *
 *   1. developer.paypal.com   (create the sandbox app + buyer)
 *   2. sandbox.paypal.com     (the buyer approving the subscription)
 *
 * Everything else is one of these three commands.
 *
 *   node scripts\sandbox-test.mjs setup
 *       Creates the sandbox plan + webhook, writes all five PayPal variables
 *       into Vercel, then deploys. Requires PAYPAL_CLIENT_ID and
 *       PAYPAL_CLIENT_SECRET to be set (sandbox values).
 *
 *   node scripts\sandbox-test.mjs verify [I-SUBSCRIPTIONID]
 *       The decisive check. Asks PayPal directly for the subscription's status
 *       and separately asks fareloop's own billing.verifyPayPal. Both must agree
 *       the subscription is ACTIVE. If you omit the id, it prints the one-line
 *       browser snippet that retrieves it from localStorage.
 *
 *   node scripts\sandbox-test.mjs revert
 *       Puts live values back and redeploys. Run this EVERY TIME. While
 *       PAYPAL_MODE is not exactly "live", production accepts only sandbox
 *       subscriptions.
 *
 * SAFETY
 * ------
 * - The PayPal host is HARDCODED to sandbox. Nothing here can reach live PayPal
 *   or move real money, whatever environment variables are set.
 * - Secrets are read from your terminal and piped to the Vercel CLI on stdin.
 *   They are never printed, never passed as command-line arguments (arguments
 *   are visible in process listings), and never written to disk.
 * - No environment value is ever pulled to a file. Not even to back one up.
 */

import { spawnSync } from "node:child_process";

const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";
const WEBHOOK_URL = process.argv[3] ?? "https://fareloop.in/api/paypal/webhook";

// The events server/paypal.ts actually reads. Subscribing to fewer than these
// means an activation can arrive with nowhere to go.
const EVENTS = [
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.REFUNDED",
];

const SECRET_VARS = new Set(["PAYPAL_CLIENT_SECRET"]);
let sawSecret = false; // never printed, only tracked as a boolean

function die(message) {
  console.error("\n[STOP] " + message + "\n");
  process.exit(1);
}

function requireCreds() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
    die(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set to SANDBOX values.\n" +
        "       Take them from developer.paypal.com -> Sandbox toggle ON -> your app.\n" +
        "       They are read from your terminal and never printed or stored."
    );
  }
}

async function token() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    die(
      `Sandbox authentication failed (HTTP ${res.status}).\n` +
        "       This almost always means the credentials are LIVE ones. Check the\n" +
        "       Sandbox/Live toggle at the top of Apps & Credentials."
    );
  }
  return (await res.json()).access_token;
}

async function call(t, path, options = {}) {
  const res = await fetch(`${SANDBOX_BASE}${path}`, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** Writes one Vercel variable. Value goes in on stdin, never as an argument. */
function setVercelEnv(name, value) {
  const result = spawnSync("vercel", ["env", "add", name, "production"], {
    input: value ?? "",
    shell: true, // Windows resolves vercel.cmd only this way
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) return (result.stderr || "").trim().split("\n")[0] ?? "unknown error";
  return null;
}

function deploy() {
  console.log("\nDeploying to production (vercel deploy --prod)...\n");
  const result = spawnSync("vercel", ["deploy", "--prod", "--yes"], { shell: true, encoding: "utf8" });
  const out = (result.stdout || "") + (result.stderr || "");
  const aliased = /Aliased\s+(\S+)/.exec(out);
  if (result.status === 0 && aliased) {
    console.log("  Deployed. Aliased to " + aliased[1] + "\n");
    return true;
  }
  console.log("  Deploy did not report an alias. Output tail:");
  console.log("  " + out.trim().split("\n").slice(-8).join("\n  "));
  return false;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
async function setup() {
  requireCreds();
  console.log("\nFareloop - SANDBOX setup");
  console.log("PayPal host: " + SANDBOX_BASE + "  (hardcoded; cannot reach live)\n");

  const t = await token();
  console.log("[1/4] Authenticated to sandbox.");

  const product = await call(t, "/v1/catalogs/products", {
    method: "POST",
    body: JSON.stringify({
      name: "Fareloop Premium",
      description: "Fareloop Premium monthly subscription",
      type: "SERVICE",
      category: "SOFTWARE",
    }),
  });
  if (!product.ok) die("Could not create the sandbox product: " + JSON.stringify(product.body).slice(0, 300));
  console.log(`[2/4] Product created: ${product.body.id}`);

  const plan = await call(t, "/v1/billing/plans", {
    method: "POST",
    body: JSON.stringify({
      product_id: product.body.id,
      name: "Fareloop Premium",
      description: "Premium monthly",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0, // renew until cancelled
          pricing_scheme: { fixed_price: { value: "9.99", currency_code: "USD" } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 0 },
    }),
  });
  if (!plan.ok) die("Could not create the sandbox plan: " + JSON.stringify(plan.body).slice(0, 300));
  console.log(`[3/4] Plan created: ${plan.body.id} @ 9.99 USD / month`);

  const webhook = await call(t, "/v1/notifications/webhooks", {
    method: "POST",
    body: JSON.stringify({ url: WEBHOOK_URL, event_types: EVENTS.map(name => ({ name })) }),
  });
  if (!webhook.ok) die("Could not create the sandbox webhook: " + JSON.stringify(webhook.body).slice(0, 300));
  console.log(`      Webhook created for ${WEBHOOK_URL} (${EVENTS.length} events)`);

  console.log("\n[4/4] Writing all five PayPal variables into Vercel (production)...\n");

  const vars = [
    ["PAYPAL_MODE", "sandbox"],
    ["PAYPAL_CLIENT_ID", process.env.PAYPAL_CLIENT_ID],
    ["PAYPAL_CLIENT_SECRET", process.env.PAYPAL_CLIENT_SECRET],
    ["PAYPAL_PREMIUM_PLAN_ID", plan.body.id],
    ["PAYPAL_WEBHOOK_ID", webhook.body.id],
  ];

  let failed = 0;
  for (const [name, value] of vars) {
    const isSecret = SECRET_VARS.has(name);
    if (isSecret) sawSecret = true;
    const err = setVercelEnv(name, value);
    if (err) {
      failed += 1;
      console.log(`  FAIL ${name}  ->  ${err}`);
      if (isSecret) {
        console.log("       The script will not echo a secret. Set it yourself:");
        console.log("           vercel env add PAYPAL_CLIENT_SECRET production");
      }
    } else {
      console.log(`  OK   ${name}${isSecret ? "  (secret, not shown)" : ""}`);
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} VARIABLE(S) FAILED. Do not deploy until these are fixed, or the`);
    console.log("site will be half-sandbox and behave unpredictably.");
    process.exit(1);
  }

  console.log("\n  ALL FIVE VARIABLES SET.");
  if (!deploy()) process.exit(1);

  console.log("=".repeat(72));
  console.log("SETUP COMPLETE. Now the only part that is yours:");
  console.log("=".repeat(72));
  console.log("\n  1. Open https://fareloop.in and SIGN IN (a fresh test account).");
  console.log("  2. Open the paywall and click subscribe.");
  console.log("  3. On sandbox.paypal.com, log in as the SANDBOX BUYER (Personal,");
  console.log("     not your merchant account) and click Agree & Subscribe.");
  console.log("\n  Then run:   node scripts\\sandbox-test.mjs verify\n");
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------
async function verify(subscriptionId) {
  if (!subscriptionId) {
    console.log(
      [
        "",
        "I need the subscription id to verify. Get it in ONE paste:",
        "",
        "  1. On fareloop.in, press F12 -> Console",
        "  2. Paste this and press Enter:",
        "",
        "     copy(localStorage.getItem('fareloop_premium_sub_id') || localStorage.getItem('fareloop_pending_sub_id'))",
        "",
        "  3. Then run:",
        "",
        "     node scripts\\sandbox-test.mjs verify <paste the I-... value here>",
        "",
      ].join("\n")
    );
    process.exit(0);
  }

  requireCreds();
  console.log("\nFareloop - SANDBOX verification\n");
  console.log("Subscription: " + subscriptionId + "\n");

  const t = await token();

  // --- The question only PayPal can answer -------------------------------
  const sub = await call(t, `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const paypalStatus = String(sub.body?.status ?? "").toUpperCase();
  const paypalActive = paypalStatus === "ACTIVE";

  console.log("[1/2] PayPal's own answer");
  console.log(`       status = ${paypalStatus || "(no status returned)"}`);
  console.log(`       ${paypalActive ? "PASS" : "FAIL"} - must be exactly ACTIVE`);
  if (sub.status === 404) {
    console.log("       (404 - PayPal does not know this id. Check it is a sandbox id,");
    console.log("        not one from the live site.)");
  }

  // --- Does fareloop agree? ----------------------------------------------
  // This is the half that was never proven: that OUR code reads PayPal's answer
  // and grants premium. It goes through the deployed endpoint, not local code.
  let fareloopPremium = null;
  let fareloopStatus = "";
  try {
    const res = await fetch("https://fareloop.in/api/trpc/billing.verifyPayPal", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (sandbox-verify)" },
      body: JSON.stringify({ json: { subscriptionId } }),
    });
    const data = await res.json();
    const json = data?.result?.data?.json;
    if (json && typeof json.premium === "boolean") {
      fareloopPremium = json.premium;
      fareloopStatus = String(json.status ?? "");
    }
  } catch {
    /* handled below */
  }

  console.log("\n[2/2] fareloop's own answer (through the deployed endpoint)");
  console.log(`       premium = ${fareloopPremium === null ? "(no answer)" : fareloopPremium}   status = ${fareloopStatus || "-"}`);
  console.log(`       ${fareloopPremium === true ? "PASS" : "FAIL"} - must be true`);

  // --- Verdict -------------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  const bothAgree = paypalActive && fareloopPremium === true;
  if (bothAgree) {
    console.log("RESULT: PASS");
    console.log("PayPal reports ACTIVE, and fareloop grants premium for it.");
    console.log("The last unproven link in the payment chain is now proven.");
  } else if (paypalActive && fareloopPremium === false) {
    console.log("RESULT: SPLIT");
    console.log("PayPal says ACTIVE but fareloop does not grant premium.");
    console.log("Wait 5 minutes first - PREMIUM_CACHE_MS memoises each verdict for");
    console.log("five minutes, so a check made BEFORE you approved can still be");
    console.log("answering. Re-run this after 5 minutes.");
  } else if (!paypalActive) {
    console.log("RESULT: NOT ACTIVE YET");
    console.log("PayPal has not marked this subscription ACTIVE, so premium is");
    console.log("correctly withheld. If you have approved it, wait a minute for the");
    console.log("mandate to settle and re-run.");
  } else {
    console.log("RESULT: COULD NOT REACH FARELOOP");
    console.log("The deployed endpoint did not answer. Re-run in a moment.");
  }
  console.log("=".repeat(72));

  console.log("\nWHEN YOU ARE DONE - put live payments back:");
  console.log("    node scripts\\sandbox-test.mjs revert\n");

  process.exit(bothAgree ? 0 : 1);
}

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------
async function revert() {
  requireCreds();
  console.log("\nFareloop - REVERT to live PayPal\n");
  console.log("Using the credentials currently in your environment as the LIVE ones.");
  console.log("If these are still sandbox values, stop and set the live ones first.\n");

  const vars = [
    ["PAYPAL_MODE", "live"],
    ["PAYPAL_CLIENT_ID", process.env.PAYPAL_CLIENT_ID],
    ["PAYPAL_CLIENT_SECRET", process.env.PAYPAL_CLIENT_SECRET],
    ["PAYPAL_PREMIUM_PLAN_ID", process.env.PAYPAL_PREMIUM_PLAN_ID],
    ["PAYPAL_WEBHOOK_ID", process.env.PAYPAL_WEBHOOK_ID],
  ];

  let failed = 0;
  for (const [name, value] of vars) {
    if (!value) {
      failed += 1;
      console.log(`  SKIP ${name}  ->  not set in your environment`);
      continue;
    }
    if (SECRET_VARS.has(name)) sawSecret = true;
    const err = setVercelEnv(name, value);
    if (err) {
      failed += 1;
      console.log(`  FAIL ${name}  ->  ${err}`);
    } else {
      console.log(`  OK   ${name}${SECRET_VARS.has(name) ? "  (secret, not shown)" : ""}`);
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} VARIABLE(S) NOT SET. Production is still on sandbox until this is fixed.`);
    process.exit(1);
  }

  console.log("\n  ALL FIVE RESTORED.");
  if (!deploy()) process.exit(1);

  console.log("=".repeat(72));
  console.log("REVERTED. Sanity-check once that a real checkout issues a genuine");
  console.log("I-... subscription and verifyPayPal reports APPROVAL_PENDING, not ACTIVE.");
  console.log("=".repeat(72) + "\n");
}

// ---------------------------------------------------------------------------
const command = process.argv[2] ?? "setup";
const arg = process.argv[3];

const runners = { setup, verify, revert };
if (!runners[command]) {
  die(`Unknown command "${command}". Use: setup | verify [I-SUBSCRIPTIONID] | revert`);
}

runners[command](command === "verify" ? arg : undefined).catch(err => {
  console.error("\n[STOP] " + err.message + "\n");
  process.exit(1);
});
