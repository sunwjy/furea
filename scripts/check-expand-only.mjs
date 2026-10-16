#!/usr/bin/env node
// The Compat tier (docs/testing.md, *Compat: the expand-only check*; ADR 0006): the previous release's Worker must
// keep working on the schema this change's migrations produce, because `deploy` migrates before it uploads.
//
//   node scripts/check-expand-only.mjs                        # packs furea@latest from the registry (network)
//   node scripts/check-expand-only.mjs --previous furea.tgz   # a tarball at hand instead
//
// Steps: pack the previous release (skip when nothing is published), start its Worker in miniflare with the bindings
// its manifest names, apply its migrations and then this change's new ones, seed an operator password, and run the
// shared smoke set (scripts/lib/smoke.mjs) against it.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { packLatest } from "./lib/pack.mjs";

const run = promisify(execFile);

const MIGRATIONS_DIR = fileURLToPath(new URL("../apps/worker/migrations/", import.meta.url));
const ADR_0006 =
  "https://github.com/sunwjy/furea/blob/main/docs/adr/0006-installer-flow.md#migrations-are-applied-before-the-code-and-must-be-expand-only";
const PASSWORD = "compat-operator-password";

/** The numbered SQL files in numeric-prefix order, as wrangler and the installer sort them. */
async function migrationFiles(dir) {
  return (await readdir(dir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b));
}

class MigrationFailure extends Error {
  constructor(file, cause) {
    super(`${file} failed to apply: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.file = file;
  }
}

/** Applies each file in one batch with its `d1_migrations` row, the way wrangler and the installer record them. */
async function applyMigrations(db, files) {
  const { unstable_splitSqlQuery: splitSqlQuery } = await import("wrangler");
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    )
    .run();
  for (const { name, path } of files) {
    try {
      const statements = splitSqlQuery(await readFile(path, "utf8")).map((sql) => db.prepare(sql));
      await db.batch([...statements, db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name)]);
    } catch (err) {
      throw new MigrationFailure(name, err);
    }
  }
}

/** Miniflare (v4-shape) options for the tarball's Worker, every binding named from its manifest (ADR 0007). */
function workerOptions(pkg, manifest, version) {
  const { bindings } = manifest;
  const vars = { FUREA_VERSION: version, FUREA_ACCOUNT_ID: "0".repeat(32) };
  return {
    modules: true,
    modulesRoot: join(pkg, "dist/worker"),
    scriptPath: join(pkg, "dist/worker", manifest.main_module),
    compatibilityDate: manifest.compatibility_date,
    compatibilityFlags: manifest.compatibility_flags,
    d1Databases: { [bindings.d1]: "compat" },
    kvNamespaces: [bindings.kv],
    // Assets first, no SPA fallback (ADR 0001): what `deploy` uploads as the assets config.
    assets: {
      directory: join(pkg, "dist/assets"),
      binding: bindings.assets,
      routerConfig: { has_user_worker: true },
      assetConfig: { not_found_handling: "none" },
    },
    analyticsEngineDatasets: bindings.analytics_engine
      ? { [bindings.analytics_engine.name]: { dataset: bindings.analytics_engine.dataset } }
      : {},
    ratelimits: Object.fromEntries(
      bindings.ratelimits.map(({ name, namespace_id, simple }) => [name, { namespace_id, simple }]),
    ),
    bindings: Object.fromEntries(bindings.plain_text.map((name) => [name, vars[name] ?? ""])),
  };
}

function failureReport(newMigrations, failing, reason) {
  const files = failing ? [failing] : newMigrations;
  return [
    failing
      ? "Compat check failed: a migration does not apply on top of the previous release's schema (ADR 0006)."
      : "Compat check failed: the previous release's Worker does not work on the new schema (ADR 0006, expand-only).",
    `  ${reason}`,
    files.length > 0 ? `  Migration: ${files.join(", ")}` : "  No new migrations: the previous release fails on its own schema.",
    `  Migrations must be expand-only: ${ADR_0006}`,
    "  Dropping or renaming a column takes two releases: stop using it in one, drop it in the next.",
  ].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: { previous: { type: "string" }, migrations: { type: "string", default: MIGRATIONS_DIR } },
  });
  const work = await mkdtemp(join(tmpdir(), "furea-compat-"));
  try {
    const tarball = values.previous ?? (await packLatest(work));
    if (tarball === null) {
      console.log("skip: no previous release");
      return 0;
    }
    await run("tar", ["-xzf", tarball, "-C", work]);
    const pkg = join(work, "package");
    const { version } = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(pkg, "dist/worker/manifest.json"), "utf8"));
    const previousMigrations = await migrationFiles(join(pkg, "migrations"));
    const newMigrations = (await migrationFiles(values.migrations)).filter((f) => !previousMigrations.includes(f));
    console.log(`previous release: furea@${version}`);
    console.log(`new migrations: ${newMigrations.length > 0 ? newMigrations.join(", ") : "none"}`);

    const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
    const { hashPassword } = await import("@furea/shared/password");
    const port = Number(process.env["FUREA_COMPAT_PORT"] ?? 0);
    // Miniflare 5 still reads the v4 option shape through its converter, which is what this file writes.
    const mf = new Miniflare(
      convertV4MiniflareOptions({ host: "127.0.0.1", port, ...workerOptions(pkg, manifest, version) }),
    );
    try {
      const base = await mf.ready;
      const db = await mf.getD1Database(manifest.bindings.d1);
      try {
        await applyMigrations(db, [
          ...previousMigrations.map((name) => ({ name, path: join(pkg, "migrations", name) })),
          ...newMigrations.map((name) => ({ name, path: join(values.migrations, name) })),
        ]);
      } catch (err) {
        if (!(err instanceof MigrationFailure)) throw err;
        console.error(failureReport(newMigrations, err.file, err.message));
        return 1;
      }
      await db
        .prepare("INSERT INTO settings (key, value) VALUES ('operator_password_hash', ?)")
        .bind(await hashPassword(PASSWORD))
        .run();

      const { runSmoke, SmokeError } = await import("./lib/smoke.mjs");
      try {
        await runSmoke(base.href, { password: PASSWORD, log: (line) => console.log(line) });
      } catch (err) {
        if (!(err instanceof SmokeError)) throw err;
        console.error(failureReport(newMigrations, null, `smoke ${err.message}`));
        return 1;
      }
      console.log(`Compat check passed: furea@${version} works on the new schema.`);
      return 0;
    } finally {
      await mf.dispose();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

process.exitCode = await main();
