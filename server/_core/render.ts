import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import path from "path";
import { pathToFileURL } from "node:url";
import superjson from "superjson";
import { destinationBySlug, cheapestMonthLabel, DESTINATIONS, type Destination } from "@shared/destinations";

type HeadMeta = {
  title: string;
  description: string;
  keywords?: string;
  canonicalPath?: string;
  noindex?: boolean;
};

const SITE_NAME = process.env.SITE_NAME || "Fareloop";
const CANONICAL_ORIGIN = (process.env.CANONICAL_ORIGIN || "https://cheapflights-lx7n3n4y.manus.space").replace(/\/$/, "");
const OG_IMAGE_URL = `${CANONICAL_ORIGIN}/og-image.png`;
const DEFAULT_KEYWORDS = "cheap flights, flight price drop alerts, fare tracker, cheapest flight tickets, flight deals, airline price alerts";

const DEFAULT_HEAD: HeadMeta = {
  title: "Fareloop – Flight Price Drop Alerts for Global Routes",
  description: "Find cheap flights, track route prices, and get timely fare-drop alerts across global routes with Fareloop.",
  keywords: DEFAULT_KEYWORDS,
  canonicalPath: "/",
};

/** Per-route SEO metadata. Keys are normalized paths (no trailing slash). */
const ROUTE_META: Record<string, HeadMeta> = {
  "/tracker": {
    title: "Flight Price Tracker – Fares & Drop Alerts | Fareloop",
    description: "Track flight prices on your routes, compare 90-day fare trends, and get alerts when prices fall below your target budget.",
    canonicalPath: "/tracker",
  },
  "/paywall": {
    title: "Fareloop Premium – Price-Drop Alerts for $9.99/Month",
    description: "Unlock unlimited route tracking, historical fare trends, target-price alerts and priority scans. Cancel anytime, no booking markups.",
    canonicalPath: "/paywall",
  },
  "/faq": {
    title: "Fareloop FAQ – Cheap Flights, Price Alerts & Booking",
    description: "Answers on finding cheap flights, how price-drop alerts work, route coverage, Premium pricing, and transparent affiliate links.",
    canonicalPath: "/faq",
  },
  "/flights-to": {
    title: "Flight Destinations – City Fare Guides | Fareloop",
    description: `Fare guides for ${DESTINATIONS.length} major cities: when to fly, which airport to use, and how to watch the price trend before you book.`,
    canonicalPath: "/flights-to",
  },
};

/** Unique per-city head meta for /flights-to/:slug destination pages. */
function destinationHead(dest: Destination, pathname: string): HeadMeta {
  return {
    title: `Cheap Flights to ${dest.city} (${dest.code}) – Fares & Alerts | Fareloop`,
    description: `Cheap flights to ${dest.city} (${dest.code}): ${cheapestMonthLabel(dest)} are the cheapest months to fly. Watch the 90-day fare trend and get price-drop alerts.`,
    keywords: `flights to ${dest.city}, cheap flights to ${dest.city}, ${dest.code} flights, ${dest.airport}, flights to ${dest.country}, ${dest.city} airfare`,
    canonicalPath: pathname,
  };
}

const notFoundHead = (pathname: string): HeadMeta => ({
  title: "Page not found | Fareloop",
  description: "This page does not exist. Search cheap flights and track fare drops with Fareloop instead.",
  canonicalPath: pathname,
  noindex: true,
});

/** Canonical path for a request URL: strips query/hash and any trailing slash. */
function normalizePath(url: string) {
  const pathname = new URL(url, "http://localhost").pathname;
  return pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
}

function resolveHead(url: string): { head: HeadMeta; status: 200 | 404 } {
  const pathname = normalizePath(url);
  if (pathname === "/") return { head: DEFAULT_HEAD, status: 200 };
  const destinationMatch = pathname.match(/^\/flights-to\/([^/]+)$/);
  if (destinationMatch) {
    const dest = destinationBySlug(decodeURIComponent(destinationMatch[1]));
    if (dest) return { head: destinationHead(dest, pathname), status: 200 };
    return { head: notFoundHead(pathname), status: 404 };
  }
  const meta = ROUTE_META[pathname];
  if (meta) return { head: { ...meta, canonicalPath: pathname }, status: 200 };
  return { head: notFoundHead(pathname), status: 404 };
}

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

/**
 * Cut text to `max` characters on a word boundary so SERP tags never end mid-word
 * (a hard slice at 159 previously truncated destination descriptions mid-token).
 * Trailing punctuation/whitespace is trimmed so the result ends on a clean word.
 */
function clipOnWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const boundary = cut.lastIndexOf(" ");
  return (boundary > 0 ? cut.slice(0, boundary) : clean.slice(0, max)).replace(/[\s.,;:!?–—-]+$/, "");
}

function buildHeadTags(head: HeadMeta) {
  const title = escapeHtml(clipOnWord(head.title, 70));
  const description = escapeHtml(clipOnWord(head.description, 155));
  const keywords = escapeHtml(clipOnWord(head.keywords || DEFAULT_KEYWORDS, 240));
  const canonical = head.canonicalPath ? `${CANONICAL_ORIGIN}${head.canonicalPath}` : undefined;
  const tags = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta name="keywords" content="${keywords}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta property="og:image" content="${escapeHtml(OG_IMAGE_URL)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${title}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${escapeHtml(OG_IMAGE_URL)}" />`,
    `<meta name="twitter:image:alt" content="${title}" />`,
  ];
  if (canonical) {
    const safeCanonical = escapeHtml(canonical);
    tags.push(`<meta property="og:url" content="${safeCanonical}" />`);
    tags.push(`<link rel="canonical" href="${safeCanonical}" />`);
  }
  if (head.noindex) tags.push(`<meta name="robots" content="noindex, follow" />`);
  // Search-console verification tags (env-gated; unset envs emit nothing).
  const verifications: Array<[name: string, env: string | undefined]> = [
    ["google-site-verification", process.env.GOOGLE_SITE_VERIFICATION],
    ["msvalidate.01", process.env.BING_SITE_VERIFICATION],
    ["yandex-verification", process.env.YANDEX_SITE_VERIFICATION],
  ];
  for (const [name, value] of verifications) {
    const token = value?.trim();
    if (token) tags.push(`<meta name="${name}" content="${escapeHtml(token)}" />`);
  }
  tags.push(`<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "TravelApplication",
    operatingSystem: "Web",
    description: head.description,
    offers: { "@type": "Offer", price: "9.99", priceCurrency: "USD" },
  }).replace(/</g, "\\u003c")}</script>`);
  tags.push(`<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: `${CANONICAL_ORIGIN}/`,
    inLanguage: "en",
  }).replace(/</g, "\\u003c")}</script>`);
  return tags.join("\n");
}

function composeHtml(template: string, appHtml: string, head: HeadMeta, dehydratedState: unknown) {
  const state = JSON.stringify(superjson.serialize(dehydratedState)).replace(/</g, "\\u003c");
  const stateScript = `<script>window.__RQ_STATE__=${state}</script>`;
  return template
    .replace("<!--app-head-->", () => buildHeadTags(head))
    .replace("<!--app-html-->", () => appHtml)
    .replace("</body>", () => `${stateScript}</body>`);
}

async function renderWithSsr(url: string, template: string, render: (url: string) => Promise<{ html: string; dehydratedState: unknown }>, res: express.Response) {
  const { head, status } = resolveHead(url);
  try {
    const result = await render(url);
    res.status(status).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(composeHtml(template, result.html, head, result.dehydratedState));
  } catch (error) {
    console.error("[SSR] render failed:", error);
    res.status(status).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(composeHtml(template, "", head, {}));
  }
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) console.error(`Could not find the build directory: ${distPath}`);
  app.use(express.static(distPath, { index: false, redirect: false }));
  app.use("*", async (req, res) => {
    if (req.path === "/index.html") return res.redirect(301, "/");
    try {
      const template = await fs.promises.readFile(path.resolve(distPath, "index.html"), "utf-8");
      const ssrModule = await import(pathToFileURL(path.resolve(import.meta.dirname, "server-ssr", "entry-server.js")).href);
      await renderWithSsr(req.originalUrl, template, ssrModule.render, res);
    } catch (error) {
      console.error("[SSR] production render failed:", error);
      res.status(200).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(composeHtml(templateFallback(), "", DEFAULT_HEAD, {}));
    }
  });
}

function templateFallback() {
  return "<!doctype html><html lang=\"en\"><head><!--app-head--></head><body><div id=\"root\"><!--app-html--></div></body></html>";
}

export { renderWithSsr, destinationHead, clipOnWord, type HeadMeta };
