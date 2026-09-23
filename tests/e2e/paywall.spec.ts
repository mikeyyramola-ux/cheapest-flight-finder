import { test, expect } from "@playwright/test";

/**
 * Regression: the premium paywall modal must always have a way back.
 *  - hardware/browser Back closes it (history entry pushed while open)
 *  - Escape closes it
 *  - tapping the dark backdrop closes it
 * Run against production with:
 *   $env:TEST_BASE_URL="https://cheapest-flight-finder.vercel.app"; $env:TEST_SKIP_SERVER="1"; npx playwright test tests/e2e/paywall.spec.ts --workers=1
 */
const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";

test.describe.configure({ mode: "serial" });
test.use({ video: "off" });

const HEADLINE = "Never wonder if you booked too soon";

async function openPaywall(page: import("@playwright/test").Page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /go premium/i }).click();
  await expect(page.getByText(HEADLINE)).toBeVisible({ timeout: 5000 });
}

test("browser Back closes the paywall instead of leaving the site", async ({ page }) => {
  await openPaywall(page);
  const urlBefore = page.url();
  await page.goBack();
  await expect(page.getByText(HEADLINE)).toBeHidden({ timeout: 5000 });
  // Still on the same page: only the pushed modal entry was popped.
  expect(page.url()).toBe(urlBefore);
});

test("Escape closes the paywall", async ({ page }) => {
  await openPaywall(page);
  await page.keyboard.press("Escape");
  await expect(page.getByText(HEADLINE)).toBeHidden({ timeout: 5000 });
});

test("tapping the backdrop closes the paywall", async ({ page }) => {
  await openPaywall(page);
  // Viewport corner is backdrop, outside the centered modal.
  await page.mouse.click(8, 8);
  await expect(page.getByText(HEADLINE)).toBeHidden({ timeout: 5000 });
});

test("Maybe later button closes the paywall", async ({ page }) => {
  await openPaywall(page);
  await page.getByRole("button", { name: /maybe later/i }).click();
  await expect(page.getByText(HEADLINE)).toBeHidden({ timeout: 5000 });
});

test("after close, Back does not strand the user on a dead entry", async ({ page }) => {
  await openPaywall(page);
  await page.getByRole("button", { name: /maybe later/i }).click();
  await expect(page.getByText(HEADLINE)).toBeHidden({ timeout: 5000 });
  // One Back from the pre-modal page should leave to the previous document (about:blank
  // in a fresh page) or do nothing meaningful — but must not reopen the modal.
  await page.goBack().catch(() => undefined);
  await expect(page.getByText(HEADLINE)).toBeHidden();
});
