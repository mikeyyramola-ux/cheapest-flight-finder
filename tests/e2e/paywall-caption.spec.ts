import { expect, test, type Page } from "@playwright/test";

/**
 * GO 165 (2026-10-11): the paywall's payment surface. Three assertions: (1) the
 * PayPal CTA is present and ENABLED - ASK 77's disabled-til design was retired
 * when the server went live and the owner worded the button open, (2) the caption
 * is visible directly under it and quotes the plan price, (3) the only Stripe
 * control present is a disabled "coming soon" button - no enabled Stripe purchase
 * option exists, because no Stripe account is connected.
 *
 * The paywall modal is closed on load (paywallOpen starts false) and Home.tsx carries no
 * data-testid attributes, so this spec opens the modal from a locked CTA and locates by
 * role/text. Playwright cannot execute on the dev PC: no gate compiles this file there
 * (tsconfig.json does not include tests/**), and the test skips unless E2E_PAYWALL=1:
 *   E2E_PAYWALL=1 TEST_SKIP_SERVER=1 TEST_BASE_URL=https://fareloop.in npx playwright test tests/e2e/paywall-caption.spec.ts
 */

const CAPTION_RE = /per month\. You review and approve the subscription on PayPal/;

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

test.describe("GO 165 - paywall payment surface", () => {
  test.skip(
    process.env.E2E_PAYWALL !== "1",
    "set E2E_PAYWALL=1 to run against a deployed build",
  );

  test("enabled PayPal CTA, price caption directly under it, no enabled Stripe option", async ({ page }) => {
    test.setTimeout(60_000);
    await openPaywall(page);
    const modal = page.locator(".paywall-modal");

    // (1) the PayPal CTA is present and clickable - this is the whole point of
    // GO 165: a hardcoded `disabled` was the only thing holding customers out.
    const payPal = modal.getByRole("button", { name: /Pay with PayPal/ });
    await expect(payPal).toBeVisible();
    await expect(payPal).toBeEnabled();

    // (2) the caption is visible directly under the PayPal CTA
    const caption = modal.getByText(CAPTION_RE);
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

  // The price is read live from the PayPal plan (server/billing.pricingPayPal)
  // so it is NOT a constant - asserting "$9.00" here would pin the suite to one
  // plan price and fail the moment the owner reprices. Assert the shape and that
  // it is a real currency amount instead.
  test("paywall shows the live plan price above the payment buttons", async ({ page }) => {
    test.setTimeout(60_000);
    await openPaywall(page);
    const modal = page.locator(".paywall-modal");

    const price = modal.locator("span").filter({ hasText: /^\$\d+\.\d{2}$/ });
    await expect(price).toHaveCount(1);
    await expect(price).toBeVisible();

    const perMonth = modal.locator("span").filter({ hasText: "/ month" });
    await expect(perMonth).toHaveCount(1);
    await expect(perMonth).toBeVisible();

    // The price block sits above the payment buttons, not beneath them.
    const priceBox = await price.boundingBox();
    const payPal = modal.getByRole("button", { name: /Pay with PayPal/ });
    const btnBox = await payPal.boundingBox();
    expect(priceBox).not.toBeNull();
    expect(btnBox).not.toBeNull();
    expect(priceBox!.y).toBeLessThan(btnBox!.y);
  });
});
