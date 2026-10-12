import { describe, expect, it, vi } from "vitest";

/**
 * THE OPTIONAL-NAME SESSION BUG.
 *
 * createSessionToken minted `name: ""` when a caller supplied no name, and its
 * paired verifySession rejects any payload whose name is not a non-empty string.
 * The result was a correctly signed, entirely valid token that could NEVER be
 * verified - the customer registered an account (the name field is optional on
 * the sign-up form), received a session cookie, and was silently signed out of
 * the account they had just created. auth.me returned null with no error shown.
 *
 * Every earlier live test passed a name, which is exactly why this was never
 * caught: the failing path was the one nobody typed into.
 *
 * These tests drive the REAL sign -> verify round trip rather than mocking it,
 * because the defect was not in either function alone - it was that the pair
 * disagreed. A mocked verification would have passed against the buggy code.
 */

// Must be set BEFORE ./_core/env is imported: ENV snapshots process.env at
// import time, and signing throws outright without a secret.
process.env.JWT_SECRET = "session-invariant-test-secret";
process.env.VITE_APP_ID = "test-app";

const { sdk } = await import("./_core/sdk");

async function verify(token: string) {
  return sdk.verifySession(token);
}

describe("session token invariant: minted => verifiable", () => {
  it("signs and verifies a token when a name IS supplied", async () => {
    const token = await sdk.createSessionToken("local_named_user", { name: "Ada Lovelace" });
    const session = await verify(token);
    expect(session).not.toBeNull();
    expect(session?.name).toBe("Ada Lovelace");
    expect(session?.openId).toBe("local_named_user");
  });

  it("still verifies when NO name is supplied at all", async () => {
    // The regression itself. Before the fix this token verified to null.
    const token = await sdk.createSessionToken("local_nameless_user");
    const session = await verify(token);
    expect(session).not.toBeNull();
    expect(session?.openId).toBe("local_nameless_user");
  });

  it("never carries an empty-string name, whatever the caller passes", async () => {
    for (const name of [undefined, "", "   ", "\t"]) {
      const token = await sdk.createSessionToken("local_probe", { name });
      const session = await verify(token);
      expect(session, `name=${JSON.stringify(name)} must still verify`).not.toBeNull();
      expect(session?.name, `name=${JSON.stringify(name)} must be non-empty`).toBeTruthy();
      expect(session?.name!.trim().length).toBeGreaterThan(0);
    }
  });

  it("falls back to the openId, so the token still identifies one account", async () => {
    const token = await sdk.createSessionToken("local_distinct_abc");
    const session = await verify(token);
    // Not just any non-empty string: it must be the identifier that resolves the
    // user, or the customer would be signed in as nobody in particular.
    expect(session?.name).toBe("local_distinct_abc");
    expect(session?.openId).toBe("local_distinct_abc");
  });

  it("trims a whitespace-only name rather than trusting it", async () => {
    const token = await sdk.createSessionToken("local_trimmed", { name: "   " });
    const session = await verify(token);
    expect(session?.name).toBe("local_trimmed");
  });

  it("keeps a supplied name intact - the fallback must not overwrite real input", async () => {
    const token = await sdk.createSessionToken("local_keep", { name: "  Padded Name  " });
    const session = await verify(token);
    expect(session?.name).toBe("Padded Name");
  });

  it("carries an exp far enough out to be a one-year session", async () => {
    // Decoded with jose rather than by hand: hand-rolling base64url here produced
    // a false failure, and this assertion is about OUR expiry, not jose's plumbing.
    const { jwtVerify } = await import("jose");
    const token = await sdk.createSessionToken("local_algo", { name: "A" });

    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET), {
      algorithms: ["HS256"],
    });

    const lifetime = (payload.exp! * 1000) - (Date.now());
    // One year, allowing generous slack for the time the test itself takes.
    expect(lifetime).toBeGreaterThan(300 * 24 * 60 * 60 * 1000);
    expect(payload.name).toBe("A");

    // And the pair still accepts it, which is the property under test.
    expect(await verify(token)).not.toBeNull();
  });

  it("rejects a token signed with a DIFFERENT secret", async () => {
    // Guards the other direction: relaxing verification to accept empty names
    // would be the wrong fix. The pair must stay strict about the secret.
    const forged = await vi.waitFor(async () => {
      const { SignJWT } = await import("jose");
      const key = new TextEncoder().encode("not-the-real-secret");
      return new SignJWT({ openId: "local_x", appId: "test-app", name: "" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("1y")
        .sign(key);
    });
    expect(await verify(forged)).toBeNull();
  });
});
