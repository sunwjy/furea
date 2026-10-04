import { copyFile } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Static Assets root is dist/assets: the SPA serves under /admin/, and favicon.ico sits at the root so
// Cloudflare answers /favicon.ico before the Worker runs (ADR 0007, ADR 0008).
const ASSETS_ROOT = new URL("./dist/assets/", import.meta.url);

function faviconAtAssetsRoot(): Plugin {
  return {
    name: "furea:favicon-at-assets-root",
    apply: "build",
    async writeBundle() {
      await copyFile(new URL("./public-root/favicon.ico", import.meta.url), new URL("favicon.ico", ASSETS_ROOT));
    },
  };
}

export default defineConfig({
  base: "/admin/",
  plugins: [react(), faviconAtAssetsRoot()],
  build: {
    outDir: new URL("admin/", ASSETS_ROOT).pathname,
    emptyOutDir: true,
  },
});
