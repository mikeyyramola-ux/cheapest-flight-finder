import { expect, test, type Page } from "@playwright/test";

/**
 * ASK 105 (roadmap Stage 2.4): the paywall caption added in ASK 102 stays visible next
 * to the disabled payment CTAs. Three assertions: (1) the PayPal CTA is present and
 * disabled, (2) the caption "Activation coming soon - payments paused until a paid
 * purchase is verified" is visible directly under it, (3) the only Stripe control
 * present is a disabled "coming soon" button - no enabled Stripe purchase option exists.
 *
 * The paywall modal is closed on load (paywallOpen starts false) and Home.tsx carries no
 * data-testid attributes, so this spec opens the modal from a locked CTA and locates by
 * role/text. Playwright cannot execute on the dev PC: no gate compiles this file there
 * (tsconfig.json does not include tests/**), and the test skips unless E2E_PAYWALL=1. Run it against a deployed build
 * that includes the ASK 102 caption (live fareloop.in still serves the pre-caption build
 * while commits stay unpushed):
 *   E2E_PAYWALL=1 TEST_SKIP_SERVER=1 TEST_BASE_URL=https://fareloop.in npx playwright test tests/e2e/paywall-caption.spec.ts
 */

const CAPTION = "Activation coming soon - payments paused until a paid purchase is verified";

async function openPaywall(page: Page) {
  await page.goto("/");
  // Locked CTA: a fresh e2e context has no premium key in localStorage, so the flight
  // card's addTracked() opens the modal. Fall back to the price-history lock card when
  // the history sidebar renders before the search results.
  const lockCard = page.getByRole("button", { name: /See the full price history/ });
  if (await lockCard.isVisible().catch(() => false)) {
    await lockCard.click();
  } else {
    await page.getByRole("button", { name: "Track this route" }).first().click();
  }
  await expect(page.locator(".paywall-modal")).toBeVisible();
}

test.describe("ASK 105 - paywall caption stays visible", () => {
  test.skip(
    process.env.E2E_PAYWALL !== "1",
    "set E2E_PAYWALL=1 to run against a deployed build carrying the ASK 102 caption",
  );

  test("disabled PayPal CTA, caption directly under it, no enabled Stripe option", async ({ page }) => {
    test.setTimeout(60_000);
    await openPaywall(page);
    const modal = page.locator(".paywall-modal");

    // (1) the PayPal CTA is present and disabled
    const payPal = modal.getByRole("button", { name: /Pay with PayPal/ });
    await expect(payPal).toBeVisible();
    await expect(payPal).toBeDisabled();

    // (2) the caption is visible directly under the PayPal CTA
    const caption = modal.getByText(CAPTION);
    await expect(caption).toBeVisible();
    const btnBox = await payPal.boundingBox();
    const capBox = await caption.boundingBox();
    expect(btnBox).not.toBeNull();
    expect(capBox).not.toBeNull();
    expect(capBox!.y).toBeGreaterThan(btnBox!.y);
    expect(capBox!.y).toBeLessThanOrEqual(btnBox!.y + btnBox!.height + 48);

    // (3) the only Stripe control present is a disabled "coming soon" button
    const stripe = modal.getByRole("button", { name: /stripe/i });
    await expect(stripe).toHaveCount(1);
    await expect(stripe).toBeDisabled();
    await expect(modal.locator('a:has-text("Stripe")')).toHaveCount(0);
  });
});

test.describe("ASK 106 - paywall price", () => {
  test.skip(
    process.env.E2E_PAYWALL !== "1",
    "set E2E_PAYWALL=1 to run against a deployed build carrying the ASK 102 caption",
  );

  test("paywall shows the owner-approved $9.00 / month price above the disabled CTAs", async ({ page }) => {
    test.setTimeout(60_000);
    await openPaywall(page);
    const modal = page.locator(".paywall-modal");

    // ASK 106: Home.tsx renders the price as two spans ("$9.00" and "/ month");
    // both must be visible inside the modal, exactly once each.
    const price = modal.locator("span").filter({ hasText: "$9.00" });
    await expect(price).toHaveCount(1);
    await expect(price).toBeVisible();

    const perMonth = modal.locator("span").filter({ hasText: "/ month" });
    await expect(perMonth).toHaveCount(1);
    await expect(perMonth).toBeVisible();

    // The price block sits above the disabled payment buttons, not beneath them.
    const priceBox = await price.boundingBox();
    const payPal = modal.getByRole("button", { name: /Pay with PayPal/ });
    const btnBox = await payPal.boundingBox();
    expect(priceBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    expect(priceBox!.y).toBeLessThan(btnBox!.y);
  });
});
