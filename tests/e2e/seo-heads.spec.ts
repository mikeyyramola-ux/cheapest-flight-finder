import { expect, test, type Page } from "@playwright/test";
import { DESTINATIONS, DESTINATION_PATHS } from "../../shared/destinations";

/**
 * SEO regression: head tags stay unique/self-canonical within SERP limits, 404s stay
 * noindex, and sitemap/robots stay on-origin and cover every destination page.
 * Run against production with:
 *   TEST_BASE_URL=https://cheapest-flight-finder.vercel.app TEST_SKIP_SERVER=1 npx playwright test tests/e2e/seo-heads.spec.ts
 */

const INDEXABLE_ROUTES = ["/", "/faq", "/flights-to", "/flights-to/london"] as const;
const NOT_FOUND_ROUTE = "/definitely-not-a-page-xyz";

type HeadSnapshot = { route: string; title: string; description: string; canonical: string; noindex: boolean };

async function readHead(page: Page, route: string): Promise<HeadSnapshot> {
  const response = await page.goto(route, { waitUntil: "domcontentloaded" });
  expect(response, `navigation to ${route} must return a response`).not.toBeNull();
  const head = await page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "",
    noindex: /noindex/i.test(document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? ""),
  }));
  return { route, ...head };
}

/** Canonical site path for a route on an origin (root keeps its trailing slash). */
const canonicalFor = (origin: string, route: string) => (route === "/" ? `${origin}/` : `${origin}${route}`);

test.describe("seo heads", () => {
  test("every route serves a unique title/description and self-canonicals", async ({ page }) => {
    const heads: HeadSnapshot[] = [];
    for (const route of [...INDEXABLE_ROUTES, NOT_FOUND_ROUTE]) heads.push(await readHead(page, route));

    const notFound = heads.find(head => head.route === NOT_FOUND_ROUTE)!;
    expect(notFound.title, "404 title").toBe("Page not found | Fareloop");
    expect(notFound.noindex, "404 pages must be noindex").toBe(true);
    for (const head of heads.filter(head => head.route !== NOT_FOUND_ROUTE)) {
      expect(head.noindex, `${head.route} must be indexable`).toBe(false);
    }

    // The declared canonical origin is env-driven, so derive it from the homepage canonical.
    const origin = new URL(heads[0].canonical).origin;
    for (const head of heads) {
      expect(head.title.length, `${head.route} title length: ${head.title}`).toBeGreaterThan(10);
      expect(head.title.length, `${head.route} title length: ${head.title}`).toBeLessThanOrEqual(70);
      expect(head.description.length, `${head.route} description length: ${head.description}`).toBeGreaterThan(50);
      expect(head.description.length, `${head.route} description length: ${head.description}`).toBeLessThanOrEqual(155);
      // A word-boundary clip strips trailing punctuation — its presence proves no mid-word truncation.
      expect(head.description.endsWith("."), `${head.route} description must end on a word: ${head.description}`).toBe(true);
      expect(head.canonical, `${head.route} must self-canonical`).toBe(canonicalFor(origin, head.route));
    }

    expect(new Set(heads.map(head => head.title)).size, "titles must be unique per route").toBe(heads.length);
    expect(new Set(heads.map(head => head.description)).size, "descriptions must be unique per route").toBe(heads.length);
  });

  test("sitemap.xml lists every app route on a single on-origin base", async ({ page, request }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const canonical = await page.evaluate(() => document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "");
    expect(canonical, "homepage must declare a canonical").toMatch(/^https:\/\/.+\/$/);
    const origin = new URL(canonical).origin;

    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);
    const xml = await response.text();
    const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map(match => match[1]);

    const expectedPaths = ["/", "/tracker", "/paywall", "/faq", "/flights-to", ...DESTINATION_PATHS];
    console.log(`SITEMAP_LOCS ${locs.length} (expected ${expectedPaths.length})`);
    expect(locs.length, `sitemap must list exactly the app routes, got ${locs.length}`).toBe(expectedPaths.length);
    for (const path of expectedPaths) expect(locs, `sitemap missing ${path}`).toContain(canonicalFor(origin, path));
    for (const loc of locs) expect(loc.startsWith(`${origin}/`), `off-origin <loc>: ${loc}`).toBe(true);
    expect(new Set(locs).size, "sitemap <loc> entries must be unique").toBe(locs.length);
    // Sanity: the destination dataset drives the sitemap, so the counts cannot drift apart.
    expect(DESTINATIONS.length).toBe(DESTINATION_PATHS.length);
  });

  test("robots.txt allows crawling and references the sitemap", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body, "must allow all user agents").toMatch(/^User-agent: \*$/m);
    expect(body, "must allow the site root").toMatch(/^Allow: \/$/m);
    expect(body, "must not disallow everything").not.toMatch(/^Disallow: \/$/m);
    expect(body, "must reference the sitemap").toMatch(/^Sitemap: https:\/\/.+\/sitemap\.xml$/m);
  });
});
