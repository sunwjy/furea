#!/usr/bin/env node
// Tarball check (docs/release.md, ADR 0007): packing packages/cli alone must yield the CLI, the Worker bundle
// and manifest, the admin assets with favicon.ico at the assets root, and every migration, and nothing else.
//
//   node scripts/check-tarball.mjs        # after `turbo run build`

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI_DIR = fileURLToPath(new URL("../packages/cli/", import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("../apps/worker/migrations/", import.meta.url));

const REQUIRED = [
  "package.json",
  "bin/furea.js",
  "dist/cli/index.js",
  "dist/worker/index.js",
  "dist/worker/manifest.json",
  "dist/assets/favicon.ico",
];
const OPTIONAL = new Set(["README.md", "LICENSE"]);

/** The migration file names the tarball must carry: the numbered SQL files in apps/worker/migrations. */
export function sourceMigrations() {
  return readdirSync(MIGRATIONS_DIR).filter((file) => /^\d{4}_.+\.sql$/.test(file));
}

/** Paths `pnpm pack` would put in the tarball of the package at `dir`. */
export function packedFiles(dir = CLI_DIR) {
  const out = execFileSync("pnpm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" });
  const { files } = JSON.parse(out);
  return files.map((file) => file.path);
}

/** Returns one problem per line; an empty list means the layout is right. */
export function checkTarball(files, migrations = sourceMigrations()) {
  const present = new Set(files);
  const expected = new Set([...REQUIRED, ...migrations.map((file) => `migrations/${file}`)]);
  const problems = [];
  for (const file of expected) if (!present.has(file)) problems.push(`missing ${file}`);
  if (!files.some((file) => file.startsWith("dist/assets/admin/"))) problems.push("missing dist/assets/admin/ (the admin SPA)");
  for (const file of files) {
    const allowed = expected.has(file) || OPTIONAL.has(file) || file.startsWith("dist/assets/");
    if (!allowed) problems.push(`unexpected ${file}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkTarball(packedFiles());
  if (problems.length > 0) {
    console.error(`Tarball check failed (ADR 0007):\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("Tarball check passed.");
}
