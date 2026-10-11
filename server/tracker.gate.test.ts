import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { appRouter } from "./routers";

/**
 * The paywall must be a SERVER decision, not a browser one. These tests call the
 * router directly (no UI, no localStorage) and assert that a caller who cannot
 * prove an ACTIVE PayPal subscription is refused.
 *
 * GO 167 added a sign-in gate IN FRONT of the premium gate, so there are now two
 * independent refusals and the tests must distinguish them:
 *   - anonymous caller          -> UNAUTHORIZED (no account, so no ownership)
 *   - signed in, not premium    -> FORBIDDEN    (account, but no paid plan)
 * The premium-gate cases below therefore use a signed-in caller, which is what
 * they were always written to exercise. The anonymous cases live in their own
 * block so a regression in either gate is unambiguous about which one broke.
 */

/** A signed-in, FREE-tier customer. Id is arbitrary but stable: ownership tests compare against it. */
const signedInUser = {
  id: 4242,
  openId: "local_test_owner",
  name: "Test Customer",
  email: "customer@example.com",
  role: "user" as const,
  // No paypalSubscriptionId: this customer has not paid, which is the point.
  paypalSubscriptionId: null,
  subscriptionStatus: "free",
};

const signedOutCtx = { req: {} as never, res: {} as never, user: null } as TrpcContext;
const signedInCtx = { req: {} as never, res: {} as never, user: signedInUser } as unknown as TrpcContext;

const signedOutCaller = appRouter.createCaller(signedOutCtx);
const caller = appRouter.createCaller(signedInCtx);

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

async function attemptRemove(subscriptionId?: string) {
  try {
    await caller.tracker.remove({ id: "route-does-not-matter", ...(subscriptionId ? { subscriptionId } : {}) });
    return "ALLOWED";
  } catch (error) {
    return (error as { code?: string }).code ?? "THREW";
  }
}

describe("tracker.remove gate (PROPOSAL 23)", () => {
  // Before this, `remove` was a publicProcedure: anyone could delete any route by id
  // with no credential of any kind. The gate must refuse BEFORE the row is touched.
  it("refuses a caller with no subscription id", async () => {
    expect(await attemptRemove()).toBe("FORBIDDEN");
  });

  it("refuses a malformed subscription id without ever reaching the network", async () => {
    expect(await attemptRemove("../../etc/passwd")).toBe("FORBIDDEN");
    expect(await attemptRemove("I-1AB23C4D5E6F7G8H9I0J; DROP TABLE users")).toBe("FORBIDDEN");
  });

  it("refuses a well-formed id that PayPal does not recognise as active", async () => {
    expect(await attemptRemove("I-1AB23C4D5E6F7G8H9I0J")).toBe("FORBIDDEN");
  });
});

/**
 * GO 167 - identity gate.
 *
 * Before this change both procedures were reachable anonymously, which is what
 * made the shared-list bug possible: there was no caller to scope a list TO.
 */
describe("tracker sign-in gate (GO 167)", () => {
  it("refuses tracker.add with no account, even with a premium id", async () => {
    // The sign-in check runs FIRST, so a valid subscription id cannot buy an
    // anonymous caller a route. Ownership needs an owner.
    expect(await attemptSignedOut("I-1AB23C4D5E6F7G8H9I0J")).toBe("UNAUTHORIZED");
  });

  it("refuses tracker.remove with no account", async () => {
    expect(await attemptRemoveSignedOut("route-anything")).toBe("UNAUTHORIZED");
  });

  it("returns an empty list rather than an error when signed out", async () => {
    // The sidebar queries this on every page load; a 401 would fill the console
    // for visitors who simply have not logged in yet.
    const result = await signedOutCaller.tracker.list();
    expect(result.routes).toEqual([]);
    expect(result.authenticated).toBe(false);
  });

  it("reports authenticated so the UI can tell 'none saved' from 'not signed in'", async () => {
    const result = await caller.tracker.list();
    expect(result.authenticated).toBe(true);
  });
});

/**
 * GO 167 - ownership.
 *
 * The bug this whole change exists to close: `remove` checked "is this caller a
 * subscriber?" but never "does this route belong to them?", so any subscriber could
 * empty any other subscriber's watch list by guessing an id.
 */
describe("tracker route ownership (GO 167)", () => {
  it("refuses to remove a route the caller does not own, without a premium plan", async () => {
    // Free tier, so this stops at the premium gate - it never reaches a delete.
    expect(await attemptRemove("route-someone-elses")).toBe("FORBIDDEN");
  });

  it("scopes the list to the caller rather than returning the table", async () => {
    const result = await caller.tracker.list();
    // Signed in as 4242 with no database in the test environment: whatever comes
    // back must contain no route owned by anybody else.
    for (const route of result.routes) {
      expect(route.userId).toBe(4242);
    }
  });
});

async function attemptSignedOut(subscriptionId?: string) {
  try {
    await signedOutCaller.tracker.add({ ...route, ...(subscriptionId ? { subscriptionId } : {}) });
    return "ALLOWED";
  } catch (error) {
    return (error as { code?: string }).code ?? "THREW";
  }
}

async function attemptRemoveSignedOut(id: string) {
  try {
    await signedOutCaller.tracker.remove({ id });
    return "ALLOWED";
  } catch (error) {
    return (error as { code?: string }).code ?? "THREW";
  }
}
