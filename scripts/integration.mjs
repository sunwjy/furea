#!/usr/bin/env node
// The Integration tier (docs/testing.md, *Integration: the CI instance*): a real install and upgrade on the CI
// account. Report-only on `main` pushes (ci.yml), a hard gate before `changeset publish` (release.yml).
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/integration.mjs   # after `turbo run build`
//     --candidate <tarball>   the build to test (default: packs packages/cli)
//     --name <instance>       default furea-ci-<short sha>
//   FUREA_RECORD_FIXTURES=1   afterwards, re-records the CLI's unit fixtures against the same account
//
// The orchestration and its assertions are scripts/lib/integration.mjs; this file wires in the real CLI builds,
// network and clock.

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { runIntegration } from "./lib/integration.mjs";
import { packCandidate, packLatest, unpack } from "./lib/pack.mjs";

const run = promisify(execFile);
const API = "https://api.cloudflare.com/client/v4";

for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (!process.env[name]) {
    console.error(`Integration needs ${name} (the CI account's deploy token and id; GitHub environment cloudflare-ci).`);
    process.exit(1);
  }
}
const token = /** @type {string} */ (process.env["CLOUDFLARE_API_TOKEN"]);
const accountId = /** @type {string} */ (process.env["CLOUDFLARE_ACCOUNT_ID"]);

async function shortSha() {
  if (process.env["GITHUB_SHA"]) return process.env["GITHUB_SHA"].slice(0, 7);
  const { stdout } = await run("git", ["rev-parse", "--short=7", "HEAD"]);
  return stdout.trim();
}

/**
 * One unpacked `furea` build, run the way an operator runs it in CI: stdin not a terminal, credentials from the
 * environment only (an empty config directory), no analytics token, so stats must answer 503.
 */
function build(root, version, configDir) {
  const env = { ...process.env, XDG_CONFIG_HOME: configDir };
  delete env["FUREA_ANALYTICS_TOKEN"];
  return {
    version,
    run: (args) =>
      run(process.execPath, [join(root, "bin/furea.js"), ...args], { env, maxBuffer: 16 * 1024 * 1024 }).then(
        ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
        (err) => ({ code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message }),
      ),
  };
}

/** `furea-ci-*` Workers scripts and D1 databases with their creation times, for the sweep. */
async function listResources() {
  const get = async (path) => {
    const res = await fetch(`${API}/accounts/${accountId}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return body.result ?? [];
  };
  const scripts = await get("/workers/scripts");
  const databases = await get("/d1/database?per_page=100&name=furea-ci-");
  return [
    ...scripts.map((s) => ({ name: s.id, createdAt: s.created_on })),
    ...databases.map((d) => ({ name: d.name, createdAt: d.created_at })),
  ];
}

function recordFixtures() {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--filter", "furea", "exec", "vitest", "run"], {
      stdio: "inherit",
      env: { ...process.env, FUREA_RECORD_FIXTURES: "1" },
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`recording fixtures exited ${code}`))));
  });
}

async function main() {
  const { values } = parseArgs({ options: { candidate: { type: "string" }, name: { type: "string" } } });
  const work = await mkdtemp(join(tmpdir(), "furea-integration-"));
  try {
    const configDir = join(work, "config");
    await mkdir(join(work, "candidate"));
    await mkdir(join(work, "latest"));
    const candidateTarball = values.candidate ?? (await packCandidate(work));
    const candidate = await unpack(candidateTarball, join(work, "candidate"));
    const latestTarball = await packLatest(join(work, "latest"));
    const latest = latestTarball ? await unpack(latestTarball, join(work, "latest")) : null;
    const name = values.name ?? `furea-ci-${await shortSha()}`;
    console.log(`candidate furea@${candidate.version}, latest ${latest ? `furea@${latest.version}` : "none"}, instance ${name}`);

    await runIntegration({
      name,
      candidate: build(candidate.dir, candidate.version, configDir),
      latest: latest && build(latest.dir, latest.version, configDir),
      fetch: globalThis.fetch,
      listResources,
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (line) => console.log(line),
    });
    console.log(`Integration passed: furea@${candidate.version} installs and upgrades on a real account.`);

    if (process.env["FUREA_RECORD_FIXTURES"] === "1") await recordFixtures();
    return 0;
  } catch (err) {
    console.error(`Integration failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

process.exitCode = await main();
