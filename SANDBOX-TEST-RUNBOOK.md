# Fareloop — PayPal Sandbox Test Runbook

**What this proves:** the one link nothing else can prove — that PayPal returns the
literal status `ACTIVE` for an approved subscription, and that fareloop turns that
into premium for the right customer.

**Cost:** about 20 minutes, most of it waiting. No real money — sandbox funds only.

---

## Who does what

Two PayPal logins are **permanently yours**, and no automation can change that:
I have no password for either and will never ask you to share one.

| | Who | Why |
|---|---|---|
| Create the sandbox app + buyer | **You** | Developer Dashboard login |
| Create plan, webhook, set Vercel vars, deploy | `setup` | One command |
| Log in as the buyer and approve | **You** | Buyer login — PayPal requires buyer consent |
| Verify it worked | `verify` | One command |
| Put live payments back | `revert` | One command |

**Your total burden: one dashboard session, then one login and one Approve click.**

---

## 1. Create the sandbox app (~3 min)

1. Go to <https://developer.paypal.com> and log in.
2. At the top of **Apps & Credentials**, click the toggle so it reads **Sandbox**.
   *(This toggle is the whole game — live credentials in sandbox fail with an
   unhelpful error.)*
3. Under **REST API apps**, click **Create App**.
4. Name it `fareloop-sandbox-test`. Click **Create App**.
5. Leave this page open. You need the **Client ID** and the **Secret**
   (click **Show**). These are *sandbox* credentials — they cannot spend real money.

---

## 2. Create the sandbox buyer (~3 min)

The merchant account was created automatically with the app. You still need a
**buyer** — the account that approves the subscription.

1. Left sidebar → **Sandbox > Accounts** → **Create Account**.
2. Account type: **Personal**. *(Personal = buyer. Business = merchant.)*
3. Email and password — **you will type this at `sandbox.paypal.com`, never
   paste it to me.**
4. Open the account → **Funding**. Give it a balance or leave the default test
   card. It must cover **9.99 USD**.

---

## 3. Run setup (~3 min)

This single command creates the plan and webhook, writes all five PayPal
variables into Vercel, and deploys:

```powershell
cd "C:\Users\ABCD\AppData\Local\Temp\opencode\cff-live"
set PAYPAL_CLIENT_ID=<sandbox Client ID from step 1>
set PAYPAL_CLIENT_SECRET=<sandbox Secret from step 1>
node scripts\sandbox-test.mjs setup
```

It ends with `SETUP COMPLETE` and the next instruction.

**Why one command, not five pastes:** your code reaches live PayPal *only* when
`PAYPAL_MODE` is exactly `live`; anything else silently uses sandbox. Change some
but not all of the variables and the site ends up half-sandbox, failing in a way
that is very hard to debug. Doing it atomically removes that failure mode.

**Safety:** the PayPal host is hardcoded to sandbox, so this cannot touch your
live account whatever environment variables are set. Your secret is piped to the
Vercel CLI on stdin — never printed, never passed as a command-line argument
(those are visible in process listings), never written to disk.

> If it says `Sandbox authentication failed`, you are holding **live** credentials.
> Check the Sandbox toggle in step 1.

---

## 4. Approve it, as the buyer (~2 min)

1. Open <https://fareloop.in> and **sign in** with a fresh test account.
   *(Signed in, or the subscription is stamped `demo` and cannot attach.)*
2. Open the paywall and click subscribe.
3. At `sandbox.paypal.com`, log in as the **buyer** from step 2 — *not* your
   merchant account. PayPal refuses to let a merchant approve their own
   subscription.
4. Confirm **9.99 USD / month** → **Agree & Subscribe**.

You land back on fareloop, which verifies the subscription automatically.

---

## 5. Verify (~1 min)

```powershell
node scripts\sandbox-test.mjs verify
```

Without an argument it prints a one-line browser snippet (F12 → Console) that
copies the subscription id to your clipboard. Then:

```powershell
node scripts\sandbox-test.mjs verify I-XXXXXXXXXXXX
```

It asks **PayPal directly** for the status, and separately asks **fareloop's own
deployed `billing.verifyPayPal`** — two independent answers that must agree.

| Verdict | Meaning |
|---|---|
| `PASS` | PayPal says `ACTIVE` **and** fareloop grants premium. The last unproven link is proven. |
| `SPLIT` | PayPal says `ACTIVE` but fareloop refuses. Almost always the **5-minute cache** — see below. Re-run after 5 minutes. |
| `NOT ACTIVE YET` | PayPal hasn't settled the mandate. Wait a minute, re-run. |

**The 5-minute trap.** fareloop memoises each premium verdict for five minutes
(`PREMIUM_CACHE_MS`). If anything checked the paywall *before* you approved, that
refusal keeps answering for up to five minutes **after you have genuinely paid**.
This single detail makes a correct integration look broken.

---

## 6. REVERT — mandatory (~1 min)

**Do not leave production on sandbox.** While `PAYPAL_MODE` is not exactly
`live`, real buyers cannot subscribe.

```powershell
set PAYPAL_CLIENT_ID=<LIVE Client ID>
set PAYPAL_CLIENT_SECRET=<LIVE Secret>
set PAYPAL_PREMIUM_PLAN_ID=<LIVE plan id>
set PAYPAL_WEBHOOK_ID=<LIVE webhook id>
node scripts\sandbox-test.mjs revert
```

It sets `PAYPAL_MODE=live`, restores the four values, and redeploys.

> The dashboard does not display existing secrets. If you have not stored the live
> ones, **rotate**: app page → **Generate new secret** → copy it immediately, as
> it is shown only once.

Then sanity-check live once: a real checkout should issue a genuine `I-…`
subscription and `verifyPayPal` should report `APPROVAL_PENDING`, not `ACTIVE`.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Sandbox authentication failed` | Sandbox toggle is off — you passed live credentials (step 1). |
| Redirect errors after login | You logged in as the **merchant**. Use the **buyer** (step 2). |
| `verify` says `SPLIT` | The 5-minute premium cache (step 5). Wait, then re-run. |
| `verify` returns 404 | That subscription id isn't a sandbox one — likely copied from the live site. |
| Checkout says `demo` | You were not signed in when you clicked subscribe (step 4). |
| `setup` says a variable FAILED | Do not deploy. The site would be half-sandbox. Fix and re-run. |
| Alerts say "no user to attribute it to" | Attribution failed. This should no longer happen — the handler now falls back to the subscriber email. Check the fareloop account email matches the PayPal buyer's email. |

---

## Why this is worth doing

Everything on fareloop's side of the wire is already proven: checkout issues a
real subscription carrying the customer's id, the webhook endpoint verifies
signatures and refuses forged events, the paywall consults PayPal live and cannot
be satisfied by anything a caller controls, and the gate lets a customer through
when PayPal reports `ACTIVE`.

The **only** thing unproven is PayPal saying the word `ACTIVE`. `verify` is the
command that closes it — with fake money, on your own keystrokes, behind logins I
will never ask you to share.
