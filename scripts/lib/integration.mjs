// The Integration tier's logic (docs/testing.md, *Integration: the CI instance*): install `furea@latest` on the CI
// account, upgrade it to the candidate, assert through the shared smoke set, re-deploy idempotently, destroy.
// Every effect (running a CLI build, HTTP, the clock, output) is injected, so the order and the assertions are
// unit-tested without an account; scripts/integration.mjs wires the real ones in.

import { expectRedirect, expectStatsUnavailable, runSmoke } from "./smoke.mjs";

export const CI_PREFIX = "furea-ci-";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The CI instances a crashed or cancelled run left behind: `furea-ci-*` resources created more than a day ago.
 * @param {{ name: string, createdAt: string | undefined }[]} resources Workers scripts and D1 databases, by name
 * @param {Date} now
 * @returns {string[]} instance names, each once
 */
export function staleInstances(resources, now) {
  const names = new Set();
  for (const { name, createdAt } of resources) {
    if (!name.startsWith(CI_PREFIX) || createdAt === undefined) continue;
    const created = Date.parse(createdAt);
    if (Number.isFinite(created) && now.getTime() - created > DAY_MS) names.add(name);
  }
  return [...names];
}

// `deploy` prints one `<step>  <create|reuse|skip>  <detail>` line per step and ends with `Ready: <url>/admin/`
// (packages/cli/src/io.ts, ADR 0006).
const STEP_LINE = /^(\S+) {2}(create|reuse|skip) {2}(.*)$/;
const READY_LINE = /^Ready: (https?:\/\/[^/\s]+)\/admin\/$/;

/**
 * @param {string} stdout what one `furea deploy` printed
 * @returns {{ url: string, password: string | undefined, steps: { step: string, action: string, detail: string }[] }}
 */
export function parseDeployOutput(stdout) {
  const steps = [];
  let url;
  for (const line of stdout.split("\n")) {
    const ready = READY_LINE.exec(line);
    if (ready) url = ready[1];
    const match = STEP_LINE.exec(line);
    if (match) steps.push({ step: match[1], action: match[2], detail: match[3] });
  }
  if (url === undefined) throw new Error(`deploy printed no "Ready:" line:\n${stdout}`);
  const password = steps.find((s) => s.step === "password" && s.action === "create")?.detail.split(/\s+/)[0];
  return { url, password, steps };
}

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} RunResult
 * @typedef {{ version: string, run(args: string[]): Promise<RunResult> }} FureaBuild one packed `furea`, runnable
 * @typedef {{
 *   name: string,
 *   candidate: FureaBuild,
 *   latest: FureaBuild | null,
 *   fetch: typeof fetch,
 *   listResources(): Promise<{ name: string, createdAt: string | undefined }[]>,
 *   now(): Date,
 *   sleep(ms: number): Promise<void>,
 *   log(line: string): void,
 *   reachTimeoutMs?: number,
 * }} IntegrationDeps
 */

/** Waits until the instance's public OpenAPI document reports `version`: the workers.dev route is live and serves it. */
async function waitForVersion(deps, url, version) {
  const deadline = deps.now().getTime() + (deps.reachTimeoutMs ?? 180_000);
  let last = "no answer yet";
  for (;;) {
    try {
      const res = await deps.fetch(`${url}/api/v1/openapi.json`);
      if (res.ok) {
        const served = (await res.json())?.info?.version;
        if (served === version) return;
        last = `serves ${served}`;
      } else {
        last = `HTTP ${res.status}`;
        await res.body?.cancel();
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (deps.now().getTime() >= deadline) throw new Error(`${url} never served furea ${version} (${last})`);
    await deps.sleep(5_000);
  }
}

/** Runs `deploy` with one build and returns its parsed transcript; a non-zero exit is a failure. */
async function deployWith(deps, build) {
  const result = await expectOk(deps, build, ["deploy", "--name", deps.name, "--workers-dev", "--no-update-check"]);
  return parseDeployOutput(result.stdout);
}

async function expectOk(deps, build, args) {
  const result = await build.run(args);
  deps.log(result.stdout.trimEnd());
  if (result.code !== 0) {
    throw new Error(`furea@${build.version} ${args[0]} exited ${result.code}:\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function destroyInstance(build, name) {
  const result = await build.run(["destroy", "--name", name, "--confirm", name]);
  if (result.code !== 0) throw new Error(`destroy ${name} failed: ${(result.stderr || result.stdout).trim()}`);
}

/** Step 1: stale `furea-ci-*` instances from crashed or cancelled runs. A warning at most, never a failure. */
async function sweep(deps) {
  let stale;
  try {
    stale = staleInstances(await deps.listResources(), deps.now());
  } catch (err) {
    deps.log(`warning: sweep: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const name of stale) {
    try {
      await destroyInstance(deps.candidate, name);
      deps.log(`sweep: destroyed ${name}`);
    } catch (err) {
      deps.log(`warning: sweep: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The whole Integration run (docs/testing.md steps 1-6). Resolves when every assertion held and the instance is gone;
 * rejects with the first failure, after destroying the instance.
 * @param {IntegrationDeps} deps
 */
export async function runIntegration(deps) {
  const { candidate, latest, fetch, log } = deps;
  await sweep(deps);
  let failure;
  try {
    // 2. The upgrade path: latest first, with one link created on it.
    let password;
    let oldLink;
    if (latest) {
      log(`--- deploy furea@${latest.version} (latest) as ${deps.name}`);
      const installed = await deployWith(deps, latest);
      password = installed.password;
      if (!password) throw new Error(`furea@${latest.version} deploy printed no password: ${deps.name} was not a fresh instance`);
      await waitForVersion(deps, installed.url, latest.version);
      oldLink = await runSmoke(installed.url, { password, slug: "ci-latest", fetch, log });
    } else {
      log("--- no furea@latest on npm: fresh install of the candidate only");
    }

    // 3. The candidate on top.
    log(`--- deploy furea@${candidate.version} (candidate)`);
    const upgraded = await deployWith(deps, candidate);
    password ??= upgraded.password;
    if (!password) throw new Error("the candidate deploy printed no password on a fresh instance");

    // 4. Assertions.
    const status = await expectOk(deps, candidate, ["status", "--name", deps.name, "--no-update-check"]);
    const reported = /^version\s+(\S+)/m.exec(status.stdout)?.[1];
    if (reported !== candidate.version) throw new Error(`status reports version ${reported}, expected ${candidate.version}`);
    await waitForVersion(deps, upgraded.url, candidate.version);
    const link = await runSmoke(upgraded.url, { password, slug: "ci-candidate", fetch, log });
    if (oldLink) {
      await expectRedirect(upgraded.url, oldLink, { fetch });
      log(`ok  /${oldLink.slug} (created under furea@${latest?.version}) still redirects`);
    }
    await expectStatsUnavailable(upgraded.url, link.slug, link.session, { fetch });
    log("ok  stats 503 analytics_unavailable");

    // 5. Idempotency: nothing left to create.
    log("--- deploy again (must only reuse or skip)");
    const again = await deployWith(deps, candidate);
    const created = again.steps.filter((s) => s.action === "create");
    if (created.length > 0) {
      throw new Error(`second deploy is not idempotent: ${created.map((s) => `${s.step} create`).join(", ")}`);
    }
    log("ok  second deploy only reused or skipped");
  } catch (err) {
    failure = err;
  }

  // 6. Always.
  log(`--- destroy ${deps.name}`);
  try {
    await destroyInstance(candidate, deps.name);
  } catch (err) {
    failure ??= err;
    if (failure !== err) log(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (failure) throw failure;
}
