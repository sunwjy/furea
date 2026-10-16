// Packed `furea` builds for the Compat and Integration tiers: the previous release from the registry, the candidate
// from packages/cli.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI_DIR = fileURLToPath(new URL("../../packages/cli/", import.meta.url));

/**
 * Packs `furea@latest` into `dir`; null when the registry has no such package. Only npm's own `E404` means
 * "nothing published", so an unreachable registry is a failure, never a skip.
 * @param {string} dir
 * @returns {Promise<string | null>} the tarball's path
 */
export async function packLatest(dir) {
  try {
    const { stdout } = await run("npm", ["pack", "furea@latest", "--json", "--pack-destination", dir], { cwd: dir });
    return join(dir, JSON.parse(stdout)[0].filename);
  } catch (err) {
    if (/\bE404\b/.test(`${err.stdout}\n${err.stderr}`)) return null;
    throw new Error(`npm pack furea@latest failed:\n${err.stderr || err.message}`);
  }
}

/**
 * Packs packages/cli (already built) into `dir`, as `changeset publish` would publish it.
 * @param {string} dir
 * @returns {Promise<string>} the tarball's path
 */
export async function packCandidate(dir) {
  const { stdout } = await run("pnpm", ["pack", "--json", "--pack-destination", dir], { cwd: CLI_DIR });
  // pnpm prints the JSON summary last; its `filename` is the tarball's absolute path.
  const summary = JSON.parse(stdout.slice(stdout.indexOf("{")));
  return summary.filename;
}

/**
 * Unpacks a tarball into `dir`.
 * @param {string} tarball @param {string} dir
 * @returns {Promise<{ dir: string, version: string }>} the package root and its version
 */
export async function unpack(tarball, dir) {
  await run("tar", ["-xzf", tarball, "-C", dir]);
  const root = join(dir, "package");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  return { dir: root, version };
}
