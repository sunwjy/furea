#!/usr/bin/env node
// Migration/changeset consistency (docs/release.md, *Migration-bearing releases*; ADR 0006): every migration file
// carries the expand-only header, and the migrations and changesets this change adds name each other through
// `Migration: NNNN_name.sql` lines.
//
//   node scripts/check-migrations.mjs                    # header check only
//   node scripts/check-migrations.mjs --base origin/main # plus the changeset rule for what HEAD adds since the base

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkMigrationRule } from "./lib/migration-rule.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS = "apps/worker/migrations";
const CHANGESETS = ".changeset";

const isMigration = (file) => /^\d{4}_.+\.sql$/.test(file);
// The changesets README and config are not changesets.
const isChangeset = (file) => file.endsWith(".md") && file !== "README.md";

/** Files under `dir` that HEAD adds relative to the merge base with `base`. */
function addedSince(base, dir) {
  const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--", dir], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

const { values } = parseArgs({ options: { base: { type: "string" } } });

const migrations = readdirSync(`${ROOT}${MIGRATIONS}`)
  .filter(isMigration)
  .map((file) => ({ file, text: readFileSync(`${ROOT}${MIGRATIONS}/${file}`, "utf8") }));
const addedMigrations = values.base ? addedSince(values.base, MIGRATIONS).map((p) => basename(p)).filter(isMigration) : [];
const addedChangesets = values.base
  ? addedSince(values.base, CHANGESETS)
      .filter((path) => isChangeset(basename(path)) && existsSync(`${ROOT}${path}`))
      .map((path) => ({ file: basename(path), text: readFileSync(`${ROOT}${path}`, "utf8") }))
  : [];

const problems = checkMigrationRule({ migrations, addedMigrations, addedChangesets });
if (problems.length > 0) {
  console.error(`Migration check failed (docs/release.md, ADR 0006):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Migration check passed${values.base ? ` (since ${values.base})` : " (headers only)"}.`);
