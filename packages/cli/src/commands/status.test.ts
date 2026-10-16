import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Fixture, type Interaction, replayFetch } from "../../test/fixtures.ts";
import { fakeTerminal } from "../../test/terminal.ts";
import { runCli } from "../cli.ts";
import { ANALYTICS_ENGINE_DOCS } from "../links.ts";

// The stand-in package of the deploy tests: its manifest declares the bindings and the Cron Trigger.
const INSTANCE = new URL("../../test/instance/", import.meta.url);
const installer = (version: string) => ({
  version,
  files: {
    workerScript: new URL("worker/index.js", INSTANCE),
    workerManifest: new URL("worker/manifest.json", INSTANCE),
    assetsRoot: new URL("assets/", INSTANCE),
    migrations: new URL("migrations/", INSTANCE),
  },
});

const DIST_TAGS = "https://registry.npmjs.org/-/package/furea/dist-tags";

/** The hand-written healthy instance (0.2.0 on workers.dev), optionally edited into another situation. */
function healthy(edit?: (fixture: Fixture) => void): Fixture {
  const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/status-healthy.json", import.meta.url), "utf8")) as Fixture;
  edit?.(fixture);
  return fixture;
}

function interaction(fixture: Fixture, urlEnd: string): Interaction {
  const found = fixture.interactions.find((i) => i.request.url.endsWith(urlEnd));
  if (!found) throw new Error(`no interaction ending in ${urlEnd}`);
  return found;
}

// Fixture bodies are untyped JSON that the tests edit in place.
// oxlint-disable-next-line no-explicit-any
type Body = any;
const result = (fixture: Fixture, urlEnd: string): Body => (interaction(fixture, urlEnd).response.body as Body).result;
const settings = (fixture: Fixture) => result(fixture, "/workers/scripts/furea/settings");

interface StatusRun {
  argv?: string[];
  env?: Record<string, string>;
  installerVersion?: string;
  /** The registry's `latest`, or an Error for a failed lookup. */
  latest?: string | Error;
}

async function status(fixture: Fixture, run: StatusRun = {}) {
  const api = replayFetch(fixture);
  const registryRequests: string[] = [];
  const registry = (async (input: string | URL | Request) => {
    registryRequests.push(String(input));
    if (String(input) !== DIST_TAGS) throw new Error(`unexpected registry request ${String(input)}`);
    if (run.latest instanceof Error || run.latest === undefined) throw run.latest ?? new TypeError("fetch failed");
    return Response.json({ latest: run.latest });
  }) as typeof fetch;
  const terminal = fakeTerminal({ interactive: false });
  const code = await runCli(["status", ...(run.argv ?? [])], {
    fetch: api.fetch,
    registryFetch: registry,
    env: { CLOUDFLARE_API_TOKEN: "TOKEN", CLOUDFLARE_ACCOUNT_ID: "ACCOUNT_ID", ...run.env },
    configDir: mkdtempSync(join(tmpdir(), "furea-cli-")),
    io: terminal,
    installer: installer(run.installerVersion ?? "0.2.0"),
  });
  api.done();
  return { code, out: terminal.stdout, err: terminal.stderr, registryRequests };
}

describe("furea status", () => {
  it("reports version, hostname, resource ids and sync-pending links of a healthy instance, exit 0", async () => {
    const { code, out, err } = await status(healthy(), { latest: "0.2.0" });
    expect(err).toEqual([]);
    expect(out).toEqual([
      "instance   furea (account ACCOUNT_ID)",
      "version    0.2.0",
      "hostname   https://furea.SUBDOMAIN_1.workers.dev (workers.dev)",
      "database   furea (ID_1)",
      "kv         furea (ID_2)",
      "cron       */5 * * * *",
      "sync       no links pending",
      "No drift.",
      "Up to date.",
    ]);
    expect(code).toBe(0);
  });

  it("names a custom domain as the hostname and does not look at workers.dev", async () => {
    const fixture = healthy((f) => {
      interaction(f, "/workers/domains?service=furea").response.body = {
        success: true,
        errors: [],
        messages: [],
        result: [{ id: "ID_5", hostname: "host-1.example.com", service: "furea", environment: "production", zone_id: "ID_6", zone_name: "example.com" }],
      };
      f.interactions = f.interactions.filter((i) => !i.request.url.endsWith("/subdomain"));
    });
    const { code, out } = await status(fixture, { latest: "0.2.0" });
    expect(out).toContain("hostname   https://host-1.example.com");
    expect(code).toBe(0);
  });

  it("counts sync-pending links as something wrong (ADR 0011)", async () => {
    const fixture = healthy((f) => {
      result(f, "/d1/database/ID_1/query")[0].results = [{ pending: 3 }];
    });
    const { code, out } = await status(fixture, { latest: "0.2.0" });
    expect(out).toContain("sync       3 links pending");
    expect(out).toContain("drift      3 links are sync pending; the Cron Trigger retries them every 5 minutes, or use Retry now in the admin");
    expect(code).toBe(1);
  });

  it.each([
    [
      "a missing rate-limit binding",
      (f: Fixture) => {
        settings(f).bindings = settings(f).bindings.filter((b: Body) => b.name !== "LOGIN_IP_LIMITER");
      },
      "drift      binding LOGIN_IP_LIMITER (ratelimit) is missing",
    ],
    [
      "a DB binding pointing at another database",
      (f: Fixture) => {
        settings(f).bindings.find((b: Body) => b.name === "DB").id = "ID_7";
      },
      "drift      binding DB points at ID_7, not the database furea (ID_1)",
    ],
    [
      "a missing Cron Trigger",
      (f: Fixture) => {
        result(f, "/workers/scripts/furea/schedules").schedules = [];
      },
      "drift      Cron Trigger */5 * * * * is missing",
    ],
    [
      "no hostname at all",
      (f: Fixture) => {
        result(f, "/workers/scripts/furea/subdomain").enabled = false;
      },
      "drift      no hostname: neither a custom domain nor workers.dev is attached",
    ],
    [
      "invocation logs switched on in the dashboard",
      (f: Fixture) => {
        settings(f).observability.logs.invocation_logs = true;
      },
      "drift      observability differs from what deploy declares: logs.invocation_logs is true, expected false",
    ],
    [
      "observability missing from the settings",
      (f: Fixture) => {
        delete settings(f).observability;
      },
      "drift      observability differs from what deploy declares: not set",
    ],
  ])("reports %s as drift, exit 1", async (_case, edit, line) => {
    const { code, out } = await status(healthy(edit), { latest: "0.2.0" });
    expect(out).toContain(line);
    expect(out).toContain("Drift found: run npx furea deploy to re-declare the instance.");
    expect(code).toBe(1);
  });

  it("reports a missing CLICKS binding as information with the docs link, never as drift", async () => {
    const fixture = healthy((f) => {
      settings(f).bindings = settings(f).bindings.filter((b: Body) => b.name !== "CLICKS");
    });
    const { code, out } = await status(fixture, { latest: "0.2.0" });
    expect(out).toContain(`analytics  no CLICKS binding (Analytics Engine is not enabled on this account): ${ANALYTICS_ENGINE_DOCS}`);
    expect(out).toContain("No drift.");
    expect(code).toBe(0);
  });

  it("stops with a hint when no instance of that name exists", async () => {
    const fixture = healthy((f) => {
      const index = f.interactions.findIndex((i) => i.request.url.endsWith("/workers/scripts/furea/settings"));
      f.interactions[index]!.response = {
        status: 404,
        body: { success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }], messages: [], result: null },
      };
      f.interactions = f.interactions.slice(0, index + 1);
    });
    const { code, err, registryRequests } = await status(fixture, { latest: "0.2.0" });
    expect(err).toEqual(['No instance named "furea" on this account. Install it with: npx furea deploy']);
    expect(registryRequests).toEqual([]);
    expect(code).toBe(1);
  });

  describe("the update check", () => {
    it("prints the newer release and never changes the exit code", async () => {
      const { code, out } = await status(healthy(), { latest: "0.2.3" });
      expect(out.at(-1)).toBe("Update available: 0.2.0 → 0.2.3. Run: npx furea@latest deploy");
      expect(code).toBe(0);
    });

    it("keeps the drift exit code whatever it finds", async () => {
      const fixture = healthy((f) => {
        result(f, "/workers/scripts/furea/schedules").schedules = [];
      });
      const { code, out } = await status(fixture, { latest: "0.2.0" });
      expect(out.at(-1)).toBe("Up to date.");
      expect(code).toBe(1);
    });

    it("compares the instance with this installer when the registry is unreachable", async () => {
      const { code, out } = await status(healthy(), { installerVersion: "0.1.0", latest: new TypeError("fetch failed") });
      expect(out.at(-1)).toBe("This installer (0.1.0) is older than the instance (0.2.0). Use npx furea@latest.");
      expect(code).toBe(0);
    });

    it.each([
      ["--no-update-check", ["--no-update-check"], {}],
      ["FUREA_NO_UPDATE_CHECK=1", [], { FUREA_NO_UPDATE_CHECK: "1" }],
    ])("skips only the registry lookup with %s", async (_case, argv, env) => {
      const { out, registryRequests } = await status(healthy(), { argv, env, installerVersion: "0.2.1", latest: "0.3.0" });
      expect(registryRequests).toEqual([]);
      expect(out.at(-1)).toBe("Update available: 0.2.0 → 0.2.1. Run: npx furea@latest deploy");
    });
  });
});
