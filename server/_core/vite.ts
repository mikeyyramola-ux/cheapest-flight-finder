import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import superjson from "superjson";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

type HeadMeta = {
  title: string;
  description: string;
  canonicalPath?: string;
  noindex?: boolean;
};

const SITE_NAME = process.env.SITE_NAME || "Fareloop";
const CANONICAL_ORIGIN = (process.env.CANONICAL_ORIGIN || "https://cheapflights-lx7n3n4y.manus.space").replace(/\/$/, "");
const DEFAULT_HEAD: HeadMeta = {
  title: "Fareloop – Flight Price Drop Alerts for Global Routes",
  description: "Find cheap flights, track route prices, and get timely fare-drop alerts across global routes with Fareloop.",
  canonicalPath: "/",
};

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

function buildHeadTags(head: HeadMeta) {
  const title = escapeHtml(head.title.slice(0, 70));
  const description = escapeHtml(head.description.replace(/\s+/g, " ").trim().slice(0, 159));
  const canonical = head.canonicalPath ? `${CANONICAL_ORIGIN}${head.canonicalPath}` : undefined;
  const tags = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
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
    name: "Fareloop",
    applicationCategory: "TravelApplication",
    operatingSystem: "Web",
    description: head.description,
    offers: { "@type": "Offer", price: "9.99", priceCurrency: "USD" },
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
  try {
    const result = await render(url);
    res.status(200).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(composeHtml(template, result.html, { ...DEFAULT_HEAD, canonicalPath: new URL(url, "http://localhost").pathname }, result.dehydratedState));
  } catch (error) {
    console.error("[SSR] render failed:", error);
    res.status(200).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(composeHtml(template, "", DEFAULT_HEAD, {}));
  }
}

export async function setupVite(app: Express, server: Server) {
  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: { middlewareMode: true, hmr: { server }, allowedHosts: true as const },
    appType: "custom",
  });
  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    try {
      const clientTemplate = path.resolve(import.meta.dirname, "../..", "client", "index.html");
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace('src="/src/entry-client.tsx"', `src="/src/entry-client.tsx?v=${nanoid()}"`);
      template = await vite.transformIndexHtml(req.originalUrl, template);
      template = template.replace("</head>", `<link rel="stylesheet" href="/src/index.css?direct" data-ssr-dev-css></head>`);
      const ssrModule = await vite.ssrLoadModule("/src/entry-server.tsx");
      await renderWithSsr(req.originalUrl, template, ssrModule.render, res);
    } catch (error) {
      vite.ssrFixStacktrace(error as Error);
      next(error);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) console.error(`Could not find the build directory: ${distPath}`);
  app.use(express.static(distPath, { index: false, redirect: false }));
  app.use("*", async (req, res) => {
    if (req.path === "/index.html") return res.redirect(301, "/");
    try {
      const template = await fs.promises.readFile(path.resolve(distPath, "index.html"), "utf-8");
      const ssrModule = await import(path.resolve(import.meta.dirname, "server-ssr", "entry-server.js"));
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
