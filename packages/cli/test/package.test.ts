// The published tarball (ADR 0007). Runs after `build` (turbo: `furea#test` depends on `build`).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkTarball, packedFiles } from "../../../scripts/check-tarball.mjs";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));

const COMPLETE = [
  "package.json",
  "bin/furea.js",
  "dist/cli/index.js",
  "dist/worker/index.js",
  "dist/worker/manifest.json",
  "dist/assets/favicon.ico",
  "dist/assets/_headers",
  "dist/assets/admin/index.html",
  "migrations/0001_init.sql",
];

describe("tarball check", () => {
  it("accepts the layout of ADR 0007", () => {
    expect(checkTarball(COMPLETE, ["0001_init.sql"])).toEqual([]);
  });

  it("names every missing or unexpected file", () => {
    const files = [...COMPLETE.filter((f) => f !== "dist/assets/favicon.ico" && !f.startsWith("migrations/")), "src/index.ts"];

    expect(checkTarball(files, ["0001_init.sql"])).toEqual([
      "missing dist/assets/favicon.ico",
      "missing migrations/0001_init.sql",
      "unexpected src/index.ts",
    ]);
  });

  it("passes on what packing the CLI package alone yields", () => {
    expect(checkTarball(packedFiles(PACKAGE_DIR))).toEqual([]);
  });
});

describe("the bundled CLI", () => {
  it("finds its own package from any working directory", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

    const out = execFileSync(process.execPath, [CLI, "--version"], { cwd: tmpdir(), encoding: "utf8" });

    expect(out.trim()).toBe(version);
  });

  it("declares no runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;

    expect([manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]).toEqual([undefined, undefined, undefined]);
  });

  it("imports nothing but Node built-ins", () => {
    const source = readFileSync(CLI, "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
      (m) => m[1] ?? m[2],
    );

    expect(specifiers.filter((s) => !s?.startsWith("node:"))).toEqual([]);
  });
});
