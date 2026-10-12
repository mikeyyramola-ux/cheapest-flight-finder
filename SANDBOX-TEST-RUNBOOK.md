# Fareloop — PayPal Sandbox Test Runbook

**What this proves:** the one link nothing else can prove — that PayPal returns the
literal status `ACTIVE` for an approved subscription, and that fareloop turns that
into premium for the right customer.

**Cost:** about 30 minutes, mostly waiting. No real money — sandbox funds only.

**Risk you must understand before you start:**
while `PAYPAL_MODE` is not the exact string `live`, **your production site accepts
only sandbox subscriptions**. Real buyers during that window would fail. Do this
in a quiet window and **do not skip step 7**.

---

## 1. Create the sandbox app (~3 min)

1. Go to <https://developer.paypal.com> and log in.
2. At the top of **Apps & Credentials**, click the toggle so it reads **Sandbox**.
   *(This toggle is the whole game. Live credentials in sandbox will fail, and the
   error is not obvious.)*
3. Under **REST API apps**, click **Create App**.
4. Name it `fareloop-sandbox-test`. Click **Create App**.
5. Leave this page open. You now see:
   - **Client ID** — click **Show** to reveal the **Secret**.
   - These are *sandbox* credentials. They cannot spend real money.

---

## 2. Create the sandbox buyer (~3 min)

The merchant account was created automatically with the app. You still need a
**buyer** — the account that will approve the subscription.

1. In the left sidebar, click **Sandbox > Accounts**.
2. Click **Create Account**.
3. Account type: **Personal**. *(Personal = buyer. Business = merchant.)*
4. Country: your country. Email: anything ending `@example.com` is fine.
   Password: something you will remember — **you will type this at
   `sandbox.paypal.com`, never paste it to me.**
5. Click **Create Account**.
6. Click the new account, then **Funding**. Give it a balance or leave the default
   test card. It must be able to cover **9.99 USD**.

---

## 3. Provision AND configure (~2 min)

PayPal has **no dashboard UI** for creating a billing plan or a webhook — both are
API-only. So this part is a script. Run it **on your own machine**, from the repo:

```powershell
cd "C:\Users\ABCD\AppData\Local\Temp\opencode\cff-live"
set PAYPAL_CLIENT_ID=<the sandbox Client ID from step 1>
set PAYPAL_CLIENT_SECRET=<the sandbox Secret from step 1>
node scripts\sandbox-provision.mjs
```

This does **both** remaining technical steps at once:

- creates the product, the **9.99 USD / month** plan, and a webhook subscribed to
  the six events fareloop actually reads, then
- writes **all five** PayPal variables into Vercel for you.

You never copy a value between two windows, which is where the mistakes happen.
It ends with either `ALL FIVE VARIABLES SET` or a list of exactly which ones
failed.

The script is **hardcoded to the sandbox host**, so it cannot touch your live
account no matter what environment variables are set. Your secret is read from
your terminal and handed straight to the Vercel CLI on stdin — never printed,
never passed as a command-line argument (arguments are visible in process
listings), never written to disk.

> If it prints `Sandbox authentication failed`, you are holding **live**
> credentials. Go back to step 1 and check the Sandbox toggle.

> If `PAYPAL_CLIENT_SECRET` fails to set, the script deliberately refuses to echo
> a secret. Set that one yourself — `vercel env add PAYPAL_CLIENT_SECRET production`
> — and paste it at the prompt.

### Why all five, together

Your code reaches live PayPal **only** when `PAYPAL_MODE` is exactly `live`;
anything else silently uses sandbox. Leave one var on a live value and the site is
in a half-sandbox state that fails in a confusing way. The script sets them as one
atomic step so that cannot happen.

---

## 4. Deploy (~3 min)

```powershell
vercel deploy --prod --yes
```

**Not** `vercel redeploy` — that rebuilds from the previous deployment's stored
source and silently ships no new code while still reporting "Ready".

Wait for `Aliased https://fareloop.in`.

---

## 5. Buy it, as the buyer (~5 min)

1. Open <https://fareloop.in> in a **normal browser window**.
2. **Sign in** with a fresh test account (or register one). You must be signed in —
   otherwise the subscription is stamped `demo` and cannot attach to an account.
3. Go to the **paywall** and click the subscribe button.
4. You are redirected to `sandbox.paypal.com`. Log in with the **buyer** account
   from step 2 — *not* your merchant account. PayPal refuses to let a merchant
   approve their own subscription.
5. Confirm **9.99 USD / month**. Click **Agree & Subscribe**.
6. You should land back on `fareloop.in/?checkout=success`.

---

## 6. Verify (~2 min + one wait)

**Wait 5 minutes.** fareloop caches each premium verdict for 5 minutes
(`PREMIUM_CACHE_MS`). If you checked the paywall *before* approving, that refusal
is cached and will keep answering for up to 5 minutes after you have paid. This
single detail makes a correct integration look broken.

Then confirm both of these:

- **The webhook landed.** In the PayPal dashboard: **Sandbox > Webhooks** (or
  the app's Webhooks section) → your webhook → **Event history**. You want a
  `BILLING.SUBSCRIPTION.ACTIVATED` with a **200** response. If you see 400/401,
  signature verification failed — see troubleshooting.
- **Premium is granted.** Signed in as the buying account on fareloop.in, adding
  a tracked route should now **succeed** instead of returning `FORBIDDEN`.

Optional but conclusive: `billing.verifyPayPal` for that subscription id should
return `premium: true, status: "ACTIVE"`.

---

## 7. REVERT — mandatory (~3 min)

**Do not leave production on sandbox.** Put the live values back:

```powershell
cd "C:\Users\ABCD\AppData\Local\Temp\opencode\cff-live"

vercel env add PAYPAL_MODE production
   live

vercel env add PAYPAL_CLIENT_ID production
   <live Client ID>

vercel env add PAYPAL_CLIENT_SECRET production
   <live Secret>

vercel env add PAYPAL_PREMIUM_PLAN_ID production
   <live plan id>

vercel env add PAYPAL_WEBHOOK_ID production
   <live webhook id>

vercel deploy --prod --yes
```

Then sanity-check live once more — a real checkout should issue a genuine `I-…`
subscription and `verifyPayPal` should report `APPROVAL_PENDING`, not `ACTIVE`.

> The dashboard does not display existing secrets. If you have not stored the live
> values, you can **rotate** them: app page → **Generate new secret** → copy it
> immediately, since it is shown only once.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Script says authentication failed | Sandbox toggle is off — you passed live credentials (step 1). |
| Redirect asks for a login and then errors | You logged in as the **merchant**. Use the **buyer** (step 2). |
| Still `FORBIDDEN` after paying | The 5-minute premium cache (step 6). Wait, or use a fresh subscription. |
| Webhook returns **401** | `PAYPAL_WEBHOOK_ID` is still the **live** id. All five vars must be sandbox (step 3). |
| Webhook returns **400** | Webhook URL mismatch, or the subscription's plan belongs to a different app. |
| Checkout says `demo` | You were not signed in when you clicked subscribe (step 5). |
| Alerts say "no user to attribute it to" | Attribution failed — but this should no longer happen, since the handler now falls back to the subscriber email. Check that the buying fareloop account's email matches the PayPal buyer's email. |
| Everything reverts by itself? | It doesn't. Step 8 is on you. |

---

## Why this is worth doing

Everything on fareloop's side of the wire is already proven: checkout issues a
real subscription carrying the customer's id, the webhook endpoint verifies
signatures and refuses forged events, the paywall consults PayPal live and cannot
be satisfied by anything a caller controls, and when PayPal says `ACTIVE` the
customer gets through.

The **only** thing left unproven is PayPal saying the word `ACTIVE`. This test is
the one that closes it — with fake money, on your own keystrokes, behind a login
I will never ask you to share.
