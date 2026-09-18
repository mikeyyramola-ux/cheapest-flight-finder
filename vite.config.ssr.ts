import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = import.meta.dirname;

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(root, "client/src"),
      "@shared": path.resolve(root, "shared"),
      "@assets": path.resolve(root, "attached_assets"),
    },
  },
  build: {
    ssr: path.resolve(root, "client/src/entry-server.tsx"),
    outDir: path.resolve(root, "dist/server-ssr"),
    emptyOutDir: true,
    rollupOptions: {
      output: { format: "es", entryFileNames: "entry-server.js" },
    },
  },
  ssr: { target: "node" },
});
