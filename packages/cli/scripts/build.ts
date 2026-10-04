// Emits dist/cli/index.js: one file, zero runtime dependencies (ADR 0007).

import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
  outfile: new URL("../dist/cli/index.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
});
