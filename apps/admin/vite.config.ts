import { rename } from "node:fs/promises";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The Static Assets root is dist/assets: the SPA serves under /admin/, and favicon.ico sits at the root so
// Cloudflare answers /favicon.ico before the Worker runs (ADR 0007, ADR 0008).
const ASSETS_ROOT = new URL("./dist/assets/", import.meta.url);
const OUT_DIR = new URL("admin/", ASSETS_ROOT);

// Vite copies public/ into outDir (dist/assets/admin/). favicon.ico and the _headers file (ADR 0017) only
// work at the assets root, so move them up.
const ROOT_FILES = ["favicon.ico", "_headers"];

function filesAtAssetsRoot(): Plugin {
  return {
    name: "furea:files-at-assets-root",
    apply: "build",
    async writeBundle() {
      for (const file of ROOT_FILES) await rename(new URL(file, OUT_DIR), new URL(file, ASSETS_ROOT));
    },
  };
}

export default defineConfig({
  base: "/admin/",
  plugins: [
    // Must run before the React plugin (TanStack Router docs).
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    filesAtAssetsRoot(),
  ],
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  build: {
    outDir: OUT_DIR.pathname,
    emptyOutDir: true,
  },
});
