// Assembles the published package (ADR 0007): dist/cli/index.js (one file, zero runtime dependencies),
// the Worker bundle and manifest, the admin assets and the migrations. Turborepo builds @furea/worker and
// @furea/admin first (they are workspace devDependencies), so `pnpm pack` here yields a complete tarball.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const WORKER = at("../../../apps/worker/");
const ADMIN = at("../../../apps/admin/");
const DIST = at("../dist/");
const MIGRATIONS = at("../migrations/");

function need(path: string, what: string): string {
  if (!existsSync(path)) throw new Error(`${what} is missing at ${path}; build it first (turbo run build).`);
  return path;
}

rmSync(DIST, { recursive: true, force: true });
rmSync(MIGRATIONS, { recursive: true, force: true });

await build({
  entryPoints: [at("../src/index.ts")],
  outfile: `${DIST}cli/index.js`,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
});

mkdirSync(`${DIST}worker`, { recursive: true });
for (const file of ["index.js", "manifest.json"]) {
  cpSync(need(`${WORKER}dist/${file}`, `The Worker's ${file}`), `${DIST}worker/${file}`);
}

cpSync(need(`${ADMIN}dist/assets/`, "The admin assets"), `${DIST}assets/`, { recursive: true });

// Copied verbatim; only the numbered SQL files, never meta files.
mkdirSync(MIGRATIONS, { recursive: true });
for (const file of readdirSync(`${WORKER}migrations`)) {
  if (/^\d{4}_.+\.sql$/.test(file)) cpSync(`${WORKER}migrations/${file}`, `${MIGRATIONS}${file}`);
}
