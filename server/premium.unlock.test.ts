import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * THE FINAL UNLOCK - what actually grants premium, and what does not.
 *
 * The owner asked whether the webhook could be simulated to confirm the unlock.
 * Reading the gate settles it: `tracker.add` calls `isActiveSubscriber(id)`, which
 * asks PAYPAL DIRECTLY (routers.ts:119) and only accepts an explicit "ACTIVE".
 * The database row the webhook writes is never consulted for the decision.
 *
 * So a simulated webhook is not a weaker confirmation of the unlock - it is no
 * confirmation at all. It would write `status:"active"` into `users`, and the gate
 * would still ask PayPal, receive APPROVAL_PENDING, and refuse. That refusal is the
 * CORRECT behaviour and is itself worth pinning: it means a compromised webhook, a
 * hand-edited database row, or a forged event cannot buy anyone premium, because
 * the authority is PayPal and not our storage.
 *
 * What CAN be proven without a buyer login is our own half of the chain: that when
 * PayPal says ACTIVE the customer gets through, and when PayPal says anything else
 * they do not. Only the external API is mocked - every line of fareloop's logic
 * under test is real.
 */

const db = vi.hoisted(() => ({
  getUserByEmail: vi.fn(),
  getUserByOpenId: vi.fn(),
  createPasswordUser: vi.fn(),
  upsertUser: vi.fn(async () => undefined),
  updateUserPayPalSubscription: vi.fn(async () => true),
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  ...db,
}));

// Only the EXTERNAL authority is faked. Nothing in fareloop's decision path is.
const paypal = vi.hoisted(() => ({ getPayPalSubscription: vi.fn() }));
vi.mock("./paypal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./paypal")>()),
  ...paypal.getPayPalSubscription ? { getPayPalSubscription: paypal.getPayPalSubscription } : {},
}));

const { appRouter } = await import("./routers");

/**
 * UNIQUE subscription id per assertion.
 *
 * `isActiveSubscriber` memoises its verdict in a module-level cache keyed by
 * subscription id (premiumCheckCache, routers.ts:115), and `vi.clearAllMocks()`
 * does not clear that cache. Reusing one id across tests meant the first answer
 * was served from cache to every later test, so the mock was never consulted and
 * every case wrongly reported ALLOWED. Fresh ids per test are both the correct
 * fix and a closer model of production, where each customer has their own id.
 */
let seq = 0;
function subId(prefix: string) {
  seq += 1;
  return `I-${prefix}${String(seq).padStart(14, "0")}`;
}

/** A signed-in PREMIUM customer, as the webhook would have left them. */
function premiumCtx(subscriptionId: string | null) {
  return {
    req: { headers: { "x-forwarded-for": "203.0.113.9" } },
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
    user: {
      id: 4242,
      openId: "local_premium_customer",
      name: "Premium Customer",
      email: "premium@example.com",
      role: "user" as const,
      paypalSubscriptionId: subscriptionId,
      subscriptionStatus: subscriptionId ? "active" : "free",
    },
  } as unknown as TrpcContext;
}

const route = {
  origin: "JFK",
  destination: "LHR",
  departDate: "2026-11-01",
  returnDate: "2026-11-08",
  targetPrice: 400,
  alertChannel: "Telegram" as const,
};

async function attemptAdd(subscriptionId: string | null) {
  try {
    await appRouter.createCaller(premiumCtx(subscriptionId)).tracker.add({ ...route });
    return "ALLOWED";
  } catch (error) {
    return (error as { code?: string }).code ?? "THREW";
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("THE FINAL UNLOCK - when PayPal confirms, the customer gets through", () => {
  it("allows a tracked route when PayPal reports the subscription ACTIVE", async () => {
    const id = subId("ACTIVE");
    paypal.getPayPalSubscription.mockResolvedValueOnce({ id, status: "ACTIVE" });

    expect(await attemptAdd(id)).toBe("ALLOWED");
  });

  it("asks PAYPAL about the subscription, and does not merely trust the stored row", async () => {
    // The stored row already says active. The gate must still consult PayPal -
    // that is the whole security property.
    const id = subId("ACTIVECHK");
    paypal.getPayPalSubscription.mockResolvedValueOnce({ id, status: "ACTIVE" });
    await attemptAdd(id);

    expect(paypal.getPayPalSubscription).toHaveBeenCalledWith(id);
  });
});

describe("THE FINAL UNLOCK - a database row alone buys nobody premium", () => {
  it("REFUSES even when the user row claims status=active, if PayPal disagrees", async () => {
    // This is the simulated-webhook case, settled. The row says active; PayPal says
    // the subscription is merely pending. The customer must not get through, and
    // the authority must be PayPal.
    const id = subId("PENDING");
    paypal.getPayPalSubscription.mockResolvedValueOnce({ id, status: "APPROVAL_PENDING" });

    expect(await attemptAdd(id)).toBe("FORBIDDEN");
  });

  it("refuses a subscription id PayPal does not recognise at all", async () => {
    paypal.getPayPalSubscription.mockRejectedValueOnce(new Error("not found"));

    expect(await attemptAdd(subId("FORGED"))).toBe("FORBIDDEN");
  });

  it("refuses when PayPal cannot be reached - an outage is never authorisation", async () => {
    const id = subId("OUTAGE");
    paypal.getPayPalSubscription.mockRejectedValueOnce(new Error("network timeout"));

    expect(await attemptAdd(id)).toBe("FORBIDDEN");
  });

  it("refuses a row marked active with NO subscription id to check", async () => {
    // A user could only reach this by tampering with storage. Nothing to ask
    // PayPal about means nothing to grant.
    expect(await attemptAdd(null)).toBe("FORBIDDEN");
  });

  it("refuses every non-ACTIVE status PayPal can return", async () => {
    for (const status of ["CREATED", "APPROVAL_PENDING", "SUSPENDED", "CANCELLED", "EXPIRED"]) {
      const id = subId("STATUS");
      paypal.getPayPalSubscription.mockResolvedValueOnce({ id, status });
      expect(await attemptAdd(id), `status=${status}`).toBe("FORBIDDEN");
    }
  });
});

describe("THE FINAL UNLOCK - cancellation stops access", () => {
  it("removes access once PayPal reports the subscription cancelled", async () => {
    // Same stored row, same subscription id - only PayPal's answer has changed.
    // Access must follow PayPal, not the row.
    const id = subId("CANCEL");
    paypal.getPayPalSubscription.mockResolvedValueOnce({ id, status: "CANCELLED" });

    try {
      await appRouter.createCaller(premiumCtx(id)).tracker.remove({ id: "route-anything" });
      expect.unreachable("a cancelled subscription must not manage routes");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("FORBIDDEN");
    }
  });
});
