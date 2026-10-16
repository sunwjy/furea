#!/usr/bin/env node
// Whether this push to `main` publishes (docs/release.md, *release.yml*): only a merged release PR does, that is no
// pending changesets and a `packages/cli` version npm does not have yet. release.yml runs the Integration gate and
// `changeset publish` only then, so ordinary pushes never spend the CI account on a release that is not happening.
//
//   node scripts/release-plan.mjs     # prints the decision; writes publish=true|false to $GITHUB_OUTPUT

import { execFile } from "node:child_process";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * @param {{ changesets: string[], version: string, published: boolean }} state
 * @returns {{ publish: boolean, reason: string }}
 */
export function releasePlan({ changesets, version, published }) {
  if (changesets.length > 0) {
    const count = `${changesets.length} pending changeset${changesets.length === 1 ? "" : "s"}`;
    return { publish: false, reason: `${count}: the release job opens or updates the release PR` };
  }
  if (version === "0.0.0") {
    return { publish: false, reason: "furea@0.0.0 is never published; 0.1.0 is bootstrapped by hand (docs/release.md)" };
  }
  if (published) return { publish: false, reason: `furea@${version} is already on npm` };
  return { publish: true, reason: `furea@${version} is not on npm yet` };
}

/** Whether the registry has this exact version; only npm's `E404` means no, anything else fails. */
async function isPublished(version) {
  try {
    const { stdout } = await promisify(execFile)("npm", ["view", `furea@${version}`, "version", "--json"]);
    return stdout.trim() !== "";
  } catch (err) {
    if (/\bE404\b/.test(`${err.stdout}\n${err.stderr}`)) return false;
    throw new Error(`npm view furea@${version} failed:\n${err.stderr || err.message}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const changesets = (await readdir(new URL(".changeset/", root))).filter((f) => f.endsWith(".md") && f !== "README.md");
  const { version } = JSON.parse(await readFile(new URL("packages/cli/package.json", root), "utf8"));
  const plan = releasePlan({
    changesets,
    version,
    published: changesets.length === 0 && version !== "0.0.0" && (await isPublished(version)),
  });
  console.log(`${plan.publish ? "publish" : "no publish"}: ${plan.reason}`);
  if (process.env["GITHUB_OUTPUT"]) await appendFile(process.env["GITHUB_OUTPUT"], `publish=${plan.publish}\n`);
}
