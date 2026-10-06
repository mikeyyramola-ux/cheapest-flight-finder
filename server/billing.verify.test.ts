import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import { getPayPalSubscription } from "./paypal";
import type { TrpcContext } from "./_core/context";

/**
 * ASK 106 (Stage 2.5, AMB 2 closed): the fail-closed matrix for verifyPayPal.
 * PayPal is mocked at the module boundary routers.ts imports, so no network and
 * no credentials are involved; what is asserted is the classification in
 * routers.verifyPayPal: only an explicit ACTIVE grants premium, every other
 * status fails closed, and each error path maps to its own reason without
 * leaking PayPal internals. paypal.test.ts already pins the id-validation
 * guard itself; this file pins the decision the router makes on the answer.
 */

function ctx(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

vi.mock("./paypal", async () => {
  const actual = await vi.importActual<typeof import("./paypal")>("./paypal");
  return { ...actual, getPayPalSubscription: vi.fn() };
});

const SUB = "I-TESTSUBSCRIPTION01";

describe("verifyPayPal fail-closed matrix", () => {
  it("grants premium only for an explicit ACTIVE subscription", async () => {
    vi.mocked(getPayPalSubscription).mockResolvedValueOnce({ id: SUB, status: "ACTIVE" });
    const result = await appRouter.createCaller(ctx()).billing.verifyPayPal({ subscriptionId: SUB });
    expect(result).toMatchObject({ premium: true, status: "ACTIVE", subscriptionId: SUB, reason: "active" });
    expect(typeof result.checkedAt).toBe("string");
  });

  it.each(["APPROVAL_PENDING", "CREATED", "SUSPENDED", "CANCELLED", "WEIRD_STATUS"])(
    "fails closed for %s",
    async status => {
      vi.mocked(getPayPalSubscription).mockResolvedValueOnce({ id: SUB, status });
      const result = await appRouter.createCaller(ctx()).billing.verifyPayPal({ subscriptionId: SUB });
      expect(result.premium).toBe(false);
      expect(result.reason).toBe("not-active");
      expect(result.status).toBe(status);
    },
  );

  it("reports an unreachable PayPal as verification-unavailable", async () => {
    vi.mocked(getPayPalSubscription).mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1"));
    const result = await appRouter.createCaller(ctx()).billing.verifyPayPal({ subscriptionId: SUB });
    expect(result).toMatchObject({ premium: false, status: "unverified", reason: "verification-unavailable" });
  });

  it("reports missing credentials as paypal-not-configured", async () => {
    vi.mocked(getPayPalSubscription).mockRejectedValueOnce(new Error("PayPal is not configured"));
    const result = await appRouter.createCaller(ctx()).billing.verifyPayPal({ subscriptionId: SUB });
    expect(result).toMatchObject({ premium: false, status: "unverified", reason: "paypal-not-configured" });
  });

  it("reports a malformed id as invalid-subscription-id", async () => {
    vi.mocked(getPayPalSubscription).mockRejectedValueOnce(new Error("Malformed subscription id"));
    const result = await appRouter.createCaller(ctx()).billing.verifyPayPal({ subscriptionId: SUB });
    expect(result).toMatchObject({ premium: false, status: "unverified", reason: "invalid-subscription-id" });
  });
});
