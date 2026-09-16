import { expect, test } from "@playwright/test";

const requiredAffiliateHost = process.env.TEST_AFFILIATE_HOST?.toLowerCase();

test.describe("hydrated affiliate booking buttons", () => {
  test("renders working booking links after React hydration", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    const searchButton = page.getByRole("button", { name: /search fares/i });
    await expect(searchButton).toBeVisible();
    await searchButton.click();

    const bookingButtons = page.locator("a.book-button");
    await expect(bookingButtons.first()).toBeVisible();
    const count = await bookingButtons.count();
    expect(count, "Expected at least one hydrated flight booking button").toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const button = bookingButtons.nth(index);
      const href = await button.getAttribute("href");
      const rel = (await button.getAttribute("rel")) ?? "";

      expect(href, `Booking button ${index + 1} must have an href`).toMatch(/^https:\/\//);
      expect(rel.split(/\s+/), `Booking button ${index + 1} must be marked sponsored`).toContain("sponsored");

      if (requiredAffiliateHost) {
        expect(new URL(href!).hostname.toLowerCase(), `Booking button ${index + 1} must use the configured affiliate host`).toMatch(
          new RegExp(`(^|\\.)${escapeRegExp(requiredAffiliateHost)}$`),
        );
      }
    }
  });
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
