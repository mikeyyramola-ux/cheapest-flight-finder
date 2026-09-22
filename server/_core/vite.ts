import { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";
import { renderWithSsr } from "./render";

/**
 * Development-only: wire Vite's dev middleware + SSR into the Express app.
 *
 * NOTE: This module is imported dynamically from index.ts and excluded from
 * the production server bundle (--external:./vite in the build script), so the
 * Vercel serverless function never loads Vite/Rollup native binaries.
 */
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
      template = template.replace('src="/src/entry-client.tsx"', `src="/src/entry-client.tsx?v=${nanoid()}`);
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
