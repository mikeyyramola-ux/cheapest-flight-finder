// Vercel serverless entry: wraps the production Express app built by
// server/_core/index.ts (bundled to dist/index.js by the build script).
process.env.NODE_ENV = process.env.NODE_ENV || "production";

import { createApp } from "../dist/index.js";

/** @type {Promise<import("express").Express> | undefined} */
let appPromise;

function getApp() {
  if (!appPromise) {
    appPromise = createApp().then((x) => x.app);
  }
  return appPromise;
}

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
