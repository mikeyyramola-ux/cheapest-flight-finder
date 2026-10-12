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
 * Everything else is one of these four commands.
 *
 *   node scripts\sandbox-test.mjs full
 *       The single click. Asks for six values once, provisions the sandbox,
 *       opens the paywall, WAITS for you to approve (finding the subscription
 *       id from PayPal itself - no F12, no pasting), verifies, then puts
 *       production back on live. This is what scripts\fareloop-test.cmd runs.
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
 * - `full` asks for the LIVE values so it can restore production, but those
 *   values are only ever written back to Vercel. They are never sent to
 *   PayPal - there is no code path in this file that could send them there.
 * - `full` writes the restore values explicitly and never falls back to the
 *   environment. During a run the environment holds SANDBOX values, and
 *   writing those back as "live" would break production payments.
 */

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

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

/**
 * Pulls a human-readable reason out of a failed Vercel CLI call.
 *
 * The CLI writes its version banner to stderr on EVERY invocation, so taking
 * stderr.split("\n")[0] always yields "Vercel CLI 59.25.0 (Node.js 24.19.0)"
 * and hides the actual failure. Vercel also reports structured failures as a
 * JSON object on stdout, which is the most precise source when present.
 */
function extractVercelError(result) {
  const out = (result.stdout || "").trim();
  const jsonError = /\{[\s\S]*?"status"\s*:\s*"error"[\s\S]*?\}/.exec(out);
  if (jsonError) {
    try {
      const parsed = JSON.parse(jsonError[0]);
      return parsed.message || parsed.reason || out.split("\n")[0];
    } catch {
      /* fall through to the text path */
    }
  }
  // Lines the CLI and the Windows shell wrap it in emit regardless of outcome.
  const noise =
    /^(Vercel CLI \d|Retrieving project|DeprecationWarning|node :|At line:|\+\s|CategoryInfo|FullyQualifiedErrorId|categoryInfo|position|char|\s*~+\s*$|.*trace-deprecation)/i;
  const lines = (result.stderr || "")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !noise.test(l));
  if (lines.length) return lines[0];
  if (out) return out.split("\n")[0];
  return `exited with code ${result.status}`;
}

/**
 * Writes one Vercel variable. Value goes in on stdin, never as an argument.
 *
 * --force is not optional here: all five PayPal names ALREADY exist on this
 * project (created 13d ago), and a bare `env add` refuses to touch a name that
 * is present for the same target. Without --force every write fails with a
 * duplicate-name error, which is exactly what happened on the first run.
 *
 * The value is still piped on stdin rather than passed with --value, because
 * --value would put your secret on the command line where it is readable in
 * process listings.
 */
function setVercelEnv(name, value) {
  const result = spawnSync("vercel", ["env", "add", name, "production", "--force"], {
    input: value ?? "",
    cwd: process.cwd(), // pin the project so a write can never land elsewhere
    shell: true, // Windows resolves vercel.cmd only this way
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status === 0) return null;
  return extractVercelError(result);
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
// Single-run helpers
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Builds a question function that works whether you are typing at a console
 * or the values are piped in.
 *
 * `rl.question` attaches a one-time "line" listener, so any line that arrives
 * while no question is pending is silently discarded. That is harmless when
 * you type - the next answer only exists once you are asked - but it loses
 * almost every value under a pipe, which also makes the code impossible to
 * test. Buffering incoming lines and pulling them in order is correct in both
 * cases.
 *
 * It resolves to an empty string once stdin closes, so a window closed
 * mid-run fails loudly instead of leaving the process waiting forever on a
 * question nobody can answer - with production sitting on sandbox and
 * nothing driving it back.
 */
function createAsk() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const buffered = [];
  let ended = false;
  let waiting = null;

  rl.on("line", line => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve("");
    }
  });

  const askFn = question =>
    new Promise(resolve => {
      process.stdout.write(question);
      if (buffered.length) return resolve(buffered.shift());
      if (ended) return resolve("");
      waiting = resolve;
    });
  askFn.done = () => rl.close();
  return askFn;
}

/** Opens a URL in the default browser without blocking this process. */
function openInBrowser(url) {
  try {
    spawn("cmd", ["/c", "start", '"', url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* a failure here is cosmetic - the URL is printed either way */
  }
}

/**
 * Asks PayPal for the newest subscription sitting on a known plan.
 *
 * This is what removes the manual step: instead of you pressing F12 and
 * pasting an id out of localStorage, the id is discovered from PayPal itself.
 */
async function newestSubscriptionForPlan(t, planId) {
  const r = await call(
    t,
    `/v1/billing/subscriptions?plan_id=${encodeURIComponent(planId)}&total_count=20`
  );
  if (!r.ok) return null;
  const subs = Array.isArray(r.body?.subscriptions) ? r.body.subscriptions : [];
  return subs.slice().sort((a, b) => String(b.create_time ?? "").localeCompare(String(a.create_time ?? "")))[0] ?? null;
}

/**
 * Waits until you have approved, then returns that subscription.
 * Reports progress once a minute so a long wait never looks like a hang.
 */
async function waitForSubscription(t, planId, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  let lastReport = Date.now();
  while (Date.now() < deadline) {
    const sub = await newestSubscriptionForPlan(t, planId).catch(() => null);
    if (sub?.id) return sub;
    if (Date.now() - lastReport >= 60_000) {
      process.stdout.write(`  still waiting (${Math.round((deadline - Date.now()) / 60000)} min left)\n`);
      lastReport = Date.now();
    }
    await sleep(5000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
/**
 * Everything setup needs, with nothing printed that belongs to a human.
 * Returns the live sandbox token and the plan id, because the single-click
 * run needs both to find your subscription afterwards.
 */
async function provision() {
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

  // PayPal allows only ONE webhook per URL per app, so a second run can never
  // create another - it fails with WEBHOOK_URL_ALREADY_EXISTS. Look it up and
  // reuse it; only create when genuinely absent. Without this the whole
  // orchestrator could only ever succeed once, and every retry died here.
  const listed = await call(t, "/v1/notifications/webhooks");
  const existing = (listed.body?.webhooks ?? []).find(w => w.url === WEBHOOK_URL);
  let webhookId;

  if (existing) {
    webhookId = existing.id;
    console.log(`      Webhook already exists for ${WEBHOOK_URL} - reusing it`);

    // A reused webhook may be subscribed to the wrong events, which would let
    // this test look green while activations silently went nowhere. Repair it
    // rather than trust that it was set up correctly.
    const have = new Set((existing.event_types ?? []).map(e => e.name));
    const missing = EVENTS.filter(name => !have.has(name));
    if (missing.length) {
      const patched = await call(t, `/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`, {
        method: "PATCH",
        body: JSON.stringify({ event_types: EVENTS.map(name => ({ name })) }),
      });
      if (!patched.ok) die("Webhook exists but its events could not be repaired: " + JSON.stringify(patched.body).slice(0, 300));
      console.log(`      Added ${missing.length} missing event type(s): ${missing.join(", ")}`);
    } else {
      console.log(`      All ${EVENTS.length} event types already subscribed`);
    }
  } else {
    const webhook = await call(t, "/v1/notifications/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: WEBHOOK_URL, event_types: EVENTS.map(name => ({ name })) }),
    });
    if (!webhook.ok) die("Could not create the sandbox webhook: " + JSON.stringify(webhook.body).slice(0, 300));
    webhookId = webhook.body.id;
    console.log(`      Webhook created for ${WEBHOOK_URL} (${EVENTS.length} events)`);
  }

  console.log("\n[4/4] Writing all five PayPal variables into Vercel (production)...\n");

  const vars = [
    ["PAYPAL_MODE", "sandbox"],
    ["PAYPAL_CLIENT_ID", process.env.PAYPAL_CLIENT_ID],
    ["PAYPAL_CLIENT_SECRET", process.env.PAYPAL_CLIENT_SECRET],
    ["PAYPAL_PREMIUM_PLAN_ID", plan.body.id],
    ["PAYPAL_WEBHOOK_ID", webhookId],
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
        console.log("           vercel env add PAYPAL_CLIENT_SECRET production --force");
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

  return { t, planId: plan.body.id };
}

async function setup() {
  await provision();

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
/**
 * The decisive check. Returns its verdict so the single-click run can chain on
 * to the revert without reprinting everything.
 */
async function verifyInner(subscriptionId) {
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

  return { bothAgree, paypalStatus, fareloopPremium };
}

async function verify(subscriptionId) {
  if (!subscriptionId) {
    console.log(
      [
        "",
        "I need the subscription id to verify. Easiest: run the single-click",
        "entry point instead - it discovers the id from PayPal for you:",
        "",
        "     scripts\\fareloop-test.cmd",
        "",
        "To verify an id you already have:",
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

  const r = await verifyInner(subscriptionId);

  console.log("\nWHEN YOU ARE DONE - put live payments back:");
  console.log("    node scripts\\sandbox-test.mjs revert\n");

  process.exit(r.bothAgree ? 0 : 1);
}

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------
/**
 * Writes the given PayPal variables and redeploys.
 *
 * Parameterised on purpose. During a single-click run the environment holds
 * SANDBOX values, so a revert that read from the environment would write
 * sandbox credentials back as "live" and quietly break production payments.
 * Callers must therefore pass the live values explicitly.
 */
function doRevert(vars) {
  let failed = 0;
  for (const [name, value] of vars) {
    if (!value) {
      failed += 1;
      console.log(`  SKIP ${name}  ->  no value available`);
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
    return false;
  }

  console.log("\n  ALL FIVE RESTORED.");
  return deploy();
}

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

  if (!doRevert(vars)) process.exit(1);

  console.log("=".repeat(72));
  console.log("REVERTED. Sanity-check once that a real checkout issues a genuine");
  console.log("I-... subscription and verifyPayPal reports APPROVAL_PENDING, not ACTIVE.");
  console.log("=".repeat(72) + "\n");
}

// ---------------------------------------------------------------------------
// full - the single click
// ---------------------------------------------------------------------------
/**
 * One unattended run: provision -> open the paywall -> wait for your approval
 * -> verify -> put production back.
 *
 * It asks for the LIVE values up front rather than at the end. If anything
 * goes wrong halfway you are never left hunting for credentials while
 * production is sitting on sandbox, and you never have to gather them at all
 * if the run is aborted early.
 */
async function full() {
  console.log("\n" + "=".repeat(72));
  console.log(" FARELOOP - complete sandbox test, one run");
  console.log("=".repeat(72));
  console.log(
    [
      "",
      "This asks for six values once, then runs unattended apart from the two",
      "PayPal logins, which stay yours alone permanently.",
      "",
      "  SANDBOX - developer.paypal.com, Sandbox toggle ON, your app:",
      "     1. Sandbox Client ID",
      "     2. Sandbox Secret",
      "",
      "  LIVE - used for ONE thing: putting production back afterwards.",
      "         They are never sent to PayPal; the host is hardcoded to sandbox.",
      "     3. Live Client ID",
      "     4. Live Secret",
      "     5. Live Plan ID",
      "     6. Live Webhook ID",
      "",
    ].join("\n")
  );

  const ask = createAsk();
  const sbxId = (await ask("  1. Sandbox Client ID : ")).trim();
  const sbxSecret = (await ask("  2. Sandbox Secret    : ")).trim();
  const liveId = (await ask("  3. Live Client ID     : ")).trim();
  const liveSecret = (await ask("  4. Live Secret        : ")).trim();
  const livePlan = (await ask("  5. Live Plan ID       : ")).trim();
  const liveWebhook = (await ask("  6. Live Webhook ID    : ")).trim();
  ask.done();
  console.log("");

  if (!sbxId || !sbxSecret) die("Sandbox Client ID and Secret are required to run the test.");

  const missing = [
    !liveId && "Live Client ID",
    !liveSecret && "Live Secret",
    !livePlan && "Live Plan ID",
    !liveWebhook && "Live Webhook ID",
  ].filter(Boolean);
  if (missing.length) {
    die(
      `Missing: ${missing.join(", ")}.\n` +
        "       Without them production cannot be put back afterwards, and it\n" +
        "       would stay on sandbox - meaning real customers could not buy.\n" +
        "       Supply all six, or run `setup` / `verify` / `revert` separately\n" +
        "       and handle the revert by hand."
    );
  }

  // provision() and verifyInner() authenticate by reading PAYPAL_CLIENT_ID and
  // PAYPAL_CLIENT_SECRET, so place the sandbox pair there. The live pair is
  // held separately and is only ever used to write back.
  process.env.PAYPAL_CLIENT_ID = sbxId;
  process.env.PAYPAL_CLIENT_SECRET = sbxSecret;

  const liveVars = [
    ["PAYPAL_MODE", "live"],
    ["PAYPAL_CLIENT_ID", liveId],
    ["PAYPAL_CLIENT_SECRET", liveSecret],
    ["PAYPAL_PREMIUM_PLAN_ID", livePlan],
    ["PAYPAL_WEBHOOK_ID", liveWebhook],
  ];

  const { t, planId } = await provision();

  console.log("\n" + "=".repeat(72));
  console.log("SETUP DONE. The paywall is opening - your part starts now.");
  console.log("=".repeat(72));
  console.log(
    [
      "",
      "  There are three things I cannot do and will never ask you to do:",
      "",
      "    1. Sign in to fareloop.in (use a fresh test account).",
      "    2. Click subscribe on the paywall.",
      "    3. On sandbox.paypal.com, log in as the SANDBOX BUYER (choose",
      "       Personal - NOT your merchant account) and Agree & Subscribe.",
      "",
      "  I am watching PayPal for the subscription to appear. You do not need",
      "  to copy an id or tell me anything - just approve it.",
      "",
    ].join("\n")
  );

  openInBrowser("https://fareloop.in/paywall");

  const sub = await waitForSubscription(t, planId, 8);
  if (!sub) {
    console.log("\n[STOP] No subscription appeared on plan " + planId + " within 8 minutes.");
    console.log("       Production is still on SANDBOX, so putting it back now.\n");
    if (doRevert(liveVars)) {
      console.log("\n  Production restored to live PayPal.");
    } else {
      console.log("\n  RESTORE FAILED. Run this yourself with your live values:");
      console.log("      node scripts\\sandbox-test.mjs revert\n");
    }
    process.exit(1);
  }

  console.log(`\nFound ${sub.id} (created ${sub.create_time}, status ${sub.status})\n`);

  const result = await verifyInner(sub.id);

  console.log("\n" + "-".repeat(72));
  console.log("Putting production back on LIVE PayPal.");
  console.log("-".repeat(72) + "\n");

  if (doRevert(liveVars)) {
    console.log("=".repeat(72));
    console.log("DONE. Production is on live PayPal again.");
    console.log("=".repeat(72));
  } else {
    console.log("=".repeat(72));
    console.log("RESTORE FAILED - PRODUCTION IS STILL ON SANDBOX.");
    console.log("A real customer cannot complete a purchase until this is fixed.");
    console.log("Run:  node scripts\\sandbox-test.mjs revert   (with your live values)");
    console.log("=".repeat(72));
  }

  process.exit(result.bothAgree ? 0 : 1);
}

// ---------------------------------------------------------------------------
const command = process.argv[2] ?? "setup";
const arg = process.argv[3];

const runners = { full, setup, verify, revert };
if (!runners[command]) {
  die(`Unknown command "${command}". Use: full | setup | verify [I-SUBSCRIPTIONID] | revert`);
}

runners[command](command === "verify" ? arg : undefined).catch(err => {
  console.error("\n[STOP] " + err.message + "\n");
  process.exit(1);
});
