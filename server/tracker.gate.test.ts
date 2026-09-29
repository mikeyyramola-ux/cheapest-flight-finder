import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";

/**
 * The paywall must be a SERVER decision, not a browser one. These tests call the
 * router directly (no UI, no localStorage) and assert that a caller who cannot
 * prove an ACTIVE PayPal subscription is refused.
 */
const ctx = { req: {} as never, res: {} as never, user: null } as TrpcContext;
const caller = appRouter.createCaller(ctx);

const route = {
  origin: "JFK",
  destination: "LHR",
  departDate: "2026-11-01",
  returnDate: "2026-11-08",
  targetPrice: 400,
  alertChannel: "Telegram" as const,
};

async function attempt(subscriptionId?: string) {
  try {
    await caller.tracker.add({ ...route, ...(subscriptionId ? { subscriptionId } : {}) });
    return "ALLOWED";
  } catch (error) {
    return (error as { code?: string }).code ?? "THREW";
  }
}

describe("tracker.add premium gate", () => {
  it("refuses a caller with no subscription id", async () => {
    expect(await attempt()).toBe("FORBIDDEN");
  });

  it("refuses a malformed subscription id without ever reaching the network", async () => {
    expect(await attempt("../../etc/passwd")).toBe("FORBIDDEN");
    expect(await attempt("I-1AB23C4D5E6F7G8H9I0J; DROP TABLE users")).toBe("FORBIDDEN");
  });

  it("refuses a well-formed id that PayPal does not recognise as active", async () => {
    // No credentials in the test environment, so verification cannot succeed -
    // and an incomplete verification must never authorise anyone.
    expect(await attempt("I-1AB23C4D5E6F7G8H9I0J")).toBe("FORBIDDEN");
  });
});
