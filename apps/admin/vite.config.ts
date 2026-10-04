import { rename } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Static Assets root is dist/assets: the SPA serves under /admin/, and favicon.ico sits at the root so
// Cloudflare answers /favicon.ico before the Worker runs (ADR 0007, ADR 0008).
const ASSETS_ROOT = new URL("./dist/assets/", import.meta.url);
const OUT_DIR = new URL("admin/", ASSETS_ROOT);

// Vite copies public/ into outDir (dist/assets/admin/); move favicon.ico up to the assets root.
function faviconAtAssetsRoot(): Plugin {
  return {
    name: "furea:favicon-at-assets-root",
    apply: "build",
    async writeBundle() {
      await rename(new URL("favicon.ico", OUT_DIR), new URL("favicon.ico", ASSETS_ROOT));
    },
  };
}

export default defineConfig({
  base: "/admin/",
  plugins: [react(), faviconAtAssetsRoot()],
  build: {
    outDir: OUT_DIR.pathname,
    emptyOutDir: true,
  },
});
