import "dotenv/config";
import express, { type Express } from "express";
import { createServer, type Server } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./render";
import { handleStripeWebhook } from "../stripe";
import { handlePayPalWebhook } from "../paypal";
import { monitorPartnersHandler, scanFlightDealsHandler } from "../scheduled";
import { opsQuotasHandler } from "../ops";
import { pageViewPixelHandler, pageViewReadHandler } from "../pageview";
import { DESTINATION_PATHS } from "@shared/destinations";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * Build the fully configured Express application.
 * Used both by the local/long-running server (startServer) and by the
 * Vercel serverless function entry (api/index.js).
 */
export async function createApp(): Promise<{ app: Express; server: Server }> {
  const app = express();
  const server = createServer(app);
  // Security headers on every response (the ASK 130 vercel.json block was inert:
  // measured live 2026-10-07 that a top-level headers key never reaches a request
  // behind this file's legacy routes catch-all - trace L571 - so the same approved
  // set now ships from the one Express app every visitor response passes through).
  const securityHeaders: Record<string, string> = {
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' https://pagead2.googlesyndication.com https://www.googletagservices.com https://www.googleadservices.com https://googleads.g.doubleclick.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://www.google.com; connect-src 'self' https://manus-analytics.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net; frame-src 'self' https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://adservice.google.com; worker-src 'self' blob:; media-src 'self'; upgrade-insecure-requests",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  };
  app.use((_req, res, next) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    next();
  });
  const canonicalOrigin = (process.env.CANONICAL_ORIGIN || "https://cheapflights-lx7n3n4y.manus.space").replace(/\/$/, "");
  app.get("/robots.txt", (_req, res) => res.type("text").send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /ops\nSitemap: ${canonicalOrigin}/sitemap.xml\n`));
  // IndexNow key endpoint (env-gated): host {INDEXNOW_KEY}.txt at the site root,
  // then submit URLs via https://api.indexnow.org/indexnow — see docs-seo-growth.md.
  const indexNowKey = process.env.INDEXNOW_KEY?.trim();
  if (indexNowKey) app.get(`/${indexNowKey}.txt`, (_req, res) => res.type("text").send(indexNowKey));
  const sitemapPaths = ["/", "/tracker", "/paywall", "/faq", "/grievance", "/refund-policy", "/flights-to", ...DESTINATION_PATHS];
  app.get("/sitemap.xml", (_req, res) => res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapPaths.map(p => `<url><loc>${canonicalOrigin}${p}</loc></url>`).join("")}</urlset>`));
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const result = await handleStripeWebhook(req.body as Buffer, req.headers["stripe-signature"] as string | undefined);
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  // PayPal webhook (needs all headers for signature verification)
  app.post("/api/paypal/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const result = await handlePayPalWebhook(req.body as Buffer, req.headers as Record<string, string>);
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/scheduled/scan-flight-deals", scanFlightDealsHandler);
  app.post("/api/scheduled/monitor-partners", monitorPartnersHandler);
  // Owner-only quota board. Registered before the body parser and the SPA fallback so
  // it is answered as an API route and never as a rendered page.
  app.get("/api/ops/quotas", opsQuotasHandler);
  // First-party page-view beacon (Option B, owner decision 2026-09-29). A GET pixel
  // counts a hit without CORS, without a body, and without tripping the read-only
  // POST gate; the read endpoint serves the dashboard chart and carries CRON_SECRET
  // so the counts are never public. Registered before the body parser and the SPA
  // fallback so both are answered as API routes and never as a rendered page.
  app.get("/api/pv.gif", pageViewPixelHandler);
  app.get("/api/pv/read", pageViewReadHandler);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    // Dynamic + externalized in the production bundle (see package.json build):
    // Vite must never be loaded inside the Vercel serverless function.
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  return { app, server };
}

async function startServer() {
  const { server } = await createApp();

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

// On Vercel the app is exported as a serverless function (see api/index.js)
// and must never call listen().
if (!process.env.VERCEL) {
  startServer().catch(console.error);
}
