import { describe, expect, it } from "vitest";
import { replayFetch } from "../test/fixtures.ts";
import { deployUpdateLine, latestRelease, statusUpdateLine } from "./update-check.ts";

const NPMJS = "https://registry.npmjs.org/-/package/furea/dist-tags";

/** A registry that answers the one dist-tags request with `latest`, and fails on anything else. */
function registry(latest: string, url = NPMJS) {
  return replayFetch({
    interactions: [{ request: { method: "GET", url }, response: { status: 200, body: { latest, snapshot: "0.0.0-abc1234-20261001000000" } } }],
  });
}

/** The newest release the update check knows of, then the line `status` prints for it. */
async function statusLine(deployed: string, installer: string, registryFetch: typeof fetch, env: Record<string, string> = {}) {
  const latest = await latestRelease({ fetch: registryFetch, env, skip: false });
  return statusUpdateLine(deployed, installer, latest);
}

describe("status update check (ADR 0006 *Update check*)", () => {
  it("offers a patch release with the upgrade command", async () => {
    const npm = registry("0.2.3");
    expect(await statusLine("0.2.0", "0.2.0", npm.fetch)).toBe("Update available: 0.2.0 → 0.2.3. Run: npx furea@latest deploy");
    npm.done();
  });

  it("sends the operator to the release notes across a 0.x minor", async () => {
    const npm = registry("0.3.1");
    expect(await statusLine("0.2.0", "0.2.0", npm.fetch)).toBe(
      "Read the release notes before upgrading 0.2.0 → 0.3.1: https://github.com/sunwjy/furea/releases. Then run: npx furea@latest deploy",
    );
    npm.done();
  });

  it("asks for a snapshot to be replaced by a release", async () => {
    const npm = registry("0.2.0");
    expect(await statusLine("0.0.0-abc1234-20261001000000", "0.2.0", npm.fetch)).toBe(
      "Snapshot deployed (0.0.0-abc1234-20261001000000); replace it with a release: npx furea@latest deploy",
    );
    npm.done();
  });

  it("warns that an installer older than the instance would hit the version gate", async () => {
    const npm = registry("0.2.0");
    expect(await statusLine("0.2.0", "0.1.4", npm.fetch)).toBe("This installer (0.1.4) is older than the instance (0.2.0). Use npx furea@latest.");
    npm.done();
  });

  it("says up to date when the instance runs the newest known release", async () => {
    const npm = registry("0.2.0");
    expect(await statusLine("0.2.0", "0.2.0", npm.fetch)).toBe("Up to date.");
    npm.done();
  });

  it("is up to date when a lagging mirror's latest is older than the instance", async () => {
    const npm = registry("0.1.0");
    expect(await statusLine("0.2.0", "0.2.0", npm.fetch)).toBe("Up to date.");
    npm.done();
  });
});

describe("the registry lookup", () => {
  it("asks npm_config_registry when set, so a mirror answers for itself", async () => {
    const npm = registry("0.2.3", "https://npm.example.com/registry/-/package/furea/dist-tags");
    expect(await latestRelease({ fetch: npm.fetch, env: { npm_config_registry: "https://npm.example.com/registry/" }, skip: false })).toBe("0.2.3");
    npm.done();
  });

  it("sends no credentials and gives up after 2 seconds", async () => {
    let init: RequestInit | undefined;
    const spy = (async (_url: string, given?: RequestInit) => {
      init = given;
      return Response.json({ latest: "0.2.3" });
    }) as typeof fetch;
    await latestRelease({ fetch: spy, env: {}, skip: false });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a network error", (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch],
    ["a non-2xx answer", (async () => Response.json({ error: "not found" }, { status: 404 })) as typeof fetch],
    ["an answer without a readable latest", (async () => Response.json({ latest: "banana" })) as typeof fetch],
    ["a non-JSON answer", (async () => new Response("<html>")) as typeof fetch],
  ])("is silent on %s and falls back to the installer as newest known", async (_case, failing) => {
    const latest = await latestRelease({ fetch: failing, env: {}, skip: false });
    expect(latest).toBeUndefined();
    expect(statusUpdateLine("0.2.0", "0.2.1", latest)).toBe("Update available: 0.2.0 → 0.2.1. Run: npx furea@latest deploy");
    expect(statusUpdateLine("0.2.0", "0.2.0", latest)).toBe("Up to date.");
  });

  it.each([
    ["--no-update-check", true, {}],
    ["FUREA_NO_UPDATE_CHECK=1", false, { FUREA_NO_UPDATE_CHECK: "1" }],
  ])("is skipped by %s without touching the network", async (_case, skip, env) => {
    let called = false;
    const spy = (async () => {
      called = true;
      return Response.json({ latest: "0.9.0" });
    }) as typeof fetch;
    expect(await latestRelease({ fetch: spy, env, skip })).toBeUndefined();
    expect(called).toBe(false);
  });

  it("still runs in CI, where pinned installers keep deploying stale releases", async () => {
    const npm = registry("0.2.3");
    expect(await latestRelease({ fetch: npm.fetch, env: { CI: "true", GITHUB_ACTIONS: "true" }, skip: false })).toBe("0.2.3");
    npm.done();
  });
});

describe("deploy's closing hint", () => {
  it("says a newer release than the one just deployed exists", () => {
    expect(deployUpdateLine("0.2.0", "0.2.3")).toBe(
      "furea 0.2.3 is out; this installer deployed 0.2.0 (a cached or pinned version). Run: npx furea@latest deploy",
    );
  });

  it.each([
    ["the installer is the latest", "0.2.0"],
    ["the registry is behind", "0.1.0"],
    ["the lookup failed or was skipped", undefined],
  ])("prints nothing when %s", (_case, latest) => {
    expect(deployUpdateLine("0.2.0", latest)).toBeUndefined();
  });
});
