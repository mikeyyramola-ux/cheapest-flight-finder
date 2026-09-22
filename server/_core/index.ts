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
import { monitorPartnersHandler, scanFlightDealsHandler } from "../scheduled";

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
  const canonicalOrigin = (process.env.CANONICAL_ORIGIN || "https://cheapflights-lx7n3n4y.manus.space").replace(/\/$/, "");
  app.get("/robots.txt", (_req, res) => res.type("text").send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${canonicalOrigin}/sitemap.xml\n`));
  app.get("/sitemap.xml", (_req, res) => res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${canonicalOrigin}/</loc></url><url><loc>${canonicalOrigin}/tracker</loc></url><url><loc>${canonicalOrigin}/paywall</loc></url><url><loc>${canonicalOrigin}/faq</loc></url></urlset>`));
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const result = await handleStripeWebhook(req.body as Buffer, req.headers["stripe-signature"] as string | undefined);
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/scheduled/scan-flight-deals", scanFlightDealsHandler);
  app.post("/api/scheduled/monitor-partners", monitorPartnersHandler);
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
