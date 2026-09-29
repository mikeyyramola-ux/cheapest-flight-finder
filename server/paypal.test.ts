import { describe, expect, it } from "vitest";
import { getPayPalSubscription } from "./paypal";

/**
 * billing.verifyPayPal is a public procedure, so whatever it is handed arrives
 * from the open internet and is interpolated into a PayPal API path on our own
 * credentials. These tests pin the guard that stops it becoming an open proxy.
 */
describe("PayPal subscription id validation", () => {
  it("rejects anything that is not a PayPal subscription id", async () => {
    const bad = [
      "../../etc/passwd",
      "I-1AB23C4D5E6F7G8H9I0J/../../v1/identity/oauth2/token",
      "https://evil.example/steal",
      "DROP TABLE users",
      "I-", // correct prefix, truncated
      "I-" + "z".repeat(80), // correct prefix, over length
      "I-1AB23C4D5E6F7G8H9I0J?foo=bar",
      "",
    ];

    for (const value of bad) {
      await expect(getPayPalSubscription(value), `should reject: ${JSON.stringify(value)}`).rejects.toThrow(/Malformed/);
    }
  });

  it("accepts the shape of a real PayPal subscription id", async () => {
    // A well-formed id passes format validation. What follows is either a config
    // error or a network call - the point here is only that the guard itself
    // does not reject a legitimate id.
    const err = await getPayPalSubscription("I-1AB23C4D5E6F7G8H9I0J").then(
      () => null,
      (error: Error) => error
    );
    expect(err?.message ?? "").not.toMatch(/Malformed/);
  });
});
