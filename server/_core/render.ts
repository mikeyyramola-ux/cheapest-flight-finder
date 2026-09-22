import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import path from "path";
import { pathToFileURL } from "node:url";
import superjson from "superjson";

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
};

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

function buildHeadTags(head: HeadMeta) {
  const title = escapeHtml(head.title.slice(0, 70));
  const description = escapeHtml(head.description.replace(/\s+/g, " ").trim().slice(0, 159));
  const keywords = escapeHtml((head.keywords || DEFAULT_KEYWORDS).slice(0, 240));
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
    url: CANONICAL_ORIGIN,
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

export { renderWithSsr, type HeadMeta };
