// Emits dist/index.js (one unminified ES module, no source map) and dist/manifest.json (ADR 0007).

import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { buildManifest } from "../src/manifest.ts";

const manifest = buildManifest();
const outdir = new URL("../dist/", import.meta.url);

await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
  outfile: new URL(manifest.main_module, outdir).pathname,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  minify: false,
  sourcemap: false,
  logLevel: "warning",
});
await writeFile(new URL("manifest.json", outdir), `${JSON.stringify(manifest, null, 2)}\n`);
