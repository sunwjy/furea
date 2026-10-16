import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPassword } from "@furea/shared";
import { describe, expect, it } from "vitest";
import { type FixtureSecrets, useFixture } from "../../test/fixtures.ts";
import { fakeTerminal } from "../../test/terminal.ts";
import { runCli } from "../cli.ts";

// A stand-in package (worker bundle, manifest, two assets, two migrations) whose bytes never change, so the
// asset hashes in the fixtures stay valid across admin builds.
const INSTANCE = new URL("../../test/instance/", import.meta.url);
const INSTALLER = {
  version: "0.2.0",
  files: {
    workerScript: new URL("worker/index.js", INSTANCE),
    workerManifest: new URL("worker/manifest.json", INSTANCE),
    assetsRoot: new URL("assets/", INSTANCE),
    migrations: new URL("migrations/", INSTANCE),
  },
};

const OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, invocation_logs: false, persist: true },
  traces: { enabled: false },
  redact_query_string: true,
};

interface Sent {
  method: string;
  url: string;
  init: RequestInit | undefined;
}

interface DeployRun {
  argv?: string[];
  interactive?: boolean;
  answers?: string[];
  env?: Record<string, string>;
  secrets?: FixtureSecrets;
}

async function deploy(scenario: string, run: DeployRun = {}) {
  const api = useFixture(scenario, { accountEnv: "CLOUDFLARE_ACCOUNT_ID", ...run.secrets });
  const sent: Sent[] = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", url: String(input), init });
    return api.fetch(input, init);
  }) as typeof fetch;
  const terminal = fakeTerminal({ interactive: run.interactive ?? false, answers: run.answers ?? [] });
  const code = await runCli(["deploy", ...(run.argv ?? [])], {
    fetch: spy,
    env: { CLOUDFLARE_API_TOKEN: api.token, CLOUDFLARE_ACCOUNT_ID: api.accountId!, ...run.env },
    configDir: mkdtempSync(join(tmpdir(), "furea-cli-")),
    io: terminal,
    installer: INSTALLER,
  });
  return { code, terminal, sent, api };
}

/** The `<step>  <action>  <detail>` lines, one per step. */
function steps(lines: string[]): Array<[string, string]> {
  return lines.flatMap((line) => {
    const match = /^(\S+) {2}(create|reuse|skip) {2}/.exec(line);
    return match ? [[match[1]!, match[2]!] as [string, string]] : [];
  });
}

async function scriptUploads(sent: Sent[]) {
  const puts = sent.filter((s) => s.method === "PUT" && s.url.endsWith("/workers/scripts/furea"));
  return Promise.all(
    puts.map(async ({ init }) => {
      const form = init!.body as FormData;
      const main = form.get("index.js") as File;
      return {
        metadata: JSON.parse(await (form.get("metadata") as File).text()) as Record<string, unknown>,
        main: { type: main.type, text: await main.text() },
      };
    }),
  );
}

function d1Queries(sent: Sent[]): Array<{ sql: string; params?: unknown[] }> {
  return sent.filter((s) => s.url.endsWith("/query")).map((s) => JSON.parse(String(s.init!.body)) as { sql: string; params?: unknown[] });
}

describe("deploy", () => {
  it("installs a fresh instance on workers.dev, prints the password once and stores the analytics token", async () => {
    const { code, terminal, sent, api } = await deploy("deploy-fresh-install", {
      interactive: true,
      answers: ["SUBDOMAIN_1", "y", "analytics-token-value"],
    });

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(steps(terminal.stdout)).toEqual([
      ["database", "create"],
      ["kv", "create"],
      ["migrations", "create"],
      ["assets", "create"],
      ["script", "create"],
      ["cron", "create"],
      ["workers.dev", "create"],
      ["password", "create"],
      ["analytics-token", "create"],
    ]);
    expect(terminal.stdout).toContain("migrations  create  applied 0001_init.sql, 0002_campaigns.sql");
    expect(terminal.stdout).toContain("workers.dev  create  https://furea.SUBDOMAIN_1.workers.dev");

    const [upload] = await scriptUploads(sent);
    expect(upload!.metadata).toEqual({
      main_module: "index.js",
      compatibility_date: "2026-09-28",
      compatibility_flags: [],
      bindings: [
        { type: "d1", name: "DB", id: "ID_1" },
        { type: "kv_namespace", name: "KV", namespace_id: "ID_2" },
        { type: "assets", name: "ASSETS" },
        { type: "analytics_engine", name: "CLICKS", dataset: "furea_clicks" },
        { type: "ratelimit", name: "LOGIN_IP_LIMITER", namespace_id: "730016001", simple: { limit: 5, period: 60 } },
        { type: "ratelimit", name: "LOGIN_GLOBAL_LIMITER", namespace_id: "730016002", simple: { limit: 30, period: 60 } },
        { type: "plain_text", name: "FUREA_VERSION", text: "0.2.0" },
        { type: "plain_text", name: "FUREA_ACCOUNT_ID", text: "ACCOUNT_ID" },
      ],
      keep_bindings: ["secret_text"],
      assets: { jwt: "JWT_2", config: { not_found_handling: "none", _headers: "/admin/*\n  X-Frame-Options: DENY\n" } },
      observability: OBSERVABILITY,
    });
    expect(upload!.main.type).toBe("application/javascript+module");
    expect(upload!.main.text).toContain("furea test instance");

    // Each migration travels with its bookkeeping row in one request.
    const queries = d1Queries(sent);
    expect(queries[1]!.sql).toMatch(/CREATE TABLE IF NOT EXISTS settings[\s\S]*INSERT INTO "d1_migrations" \(name\) values \('0001_init.sql'\);$/);
    expect(queries[2]!.sql).toMatch(/CREATE TABLE IF NOT EXISTS campaigns[\s\S]*INSERT INTO "d1_migrations" \(name\) values \('0002_campaigns.sql'\);$/);

    // The printed password is the one whose hash went into D1.
    const printed = terminal.stdout.join("\n").match(/password {2}create {2}(\S+)/)?.[1];
    expect(printed).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz]{24}$/);
    const insert = queries.at(-1)!;
    expect(insert.sql).toContain("operator_password_hash");
    expect(await verifyPassword(printed!, insert.params![0] as string)).toBe(true);
    expect(terminal.stdout.join("\n").split(printed!).length - 1).toBe(1);

    expect(terminal.questions).toEqual([
      "No workers.dev subdomain on this account yet. Choose one (account-wide, <name>.workers.dev): ",
      "Set the analytics token now? It enables click breakdowns. [y/N] ",
      "Paste the analytics token: ",
    ]);
    expect(terminal.opened).toEqual([
      "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=furea-analytics",
    ]);
    const secret = sent.find((s) => s.url.endsWith("/secrets"))!;
    expect(JSON.parse(String(secret.init!.body))).toEqual({ name: "ANALYTICS_TOKEN", text: "analytics-token-value", type: "secret_text" });
    api.done();
  });

  it("upgrades an instance: applies only the pending migration before the upload and keeps the stored secret", async () => {
    const { code, terminal, sent, api } = await deploy("deploy-upgrade");

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.stdout).toContain("migrations  create  applied 0002_campaigns.sql");
    expect(terminal.stdout).toContain("script  reuse  furea 0.1.0 → 0.2.0");
    expect(steps(terminal.stdout).filter(([, action]) => action === "create")).toEqual([["migrations", "create"]]);
    const order = sent.map((s) => `${s.method} ${new URL(s.url).pathname.split("/").slice(-2).join("/")}`);
    expect(order.indexOf("POST ID_1/query")).toBeLessThan(order.indexOf("PUT scripts/furea"));
    const [upload] = await scriptUploads(sent);
    expect(upload!.metadata.keep_bindings).toEqual(["secret_text"]);
    expect(JSON.stringify(upload!.metadata)).not.toContain("ANALYTICS_TOKEN");
    expect(terminal.stdout.join("\n")).not.toMatch(/analytics-token/);
    api.done();
  });

  it("prints only reuse and skip when nothing changed", async () => {
    const { code, terminal, api } = await deploy("deploy-redeploy");

    expect(code).toBe(0);
    expect(steps(terminal.stdout)).toEqual([
      ["database", "reuse"],
      ["kv", "reuse"],
      ["migrations", "skip"],
      ["assets", "reuse"],
      ["script", "reuse"],
      ["cron", "reuse"],
      ["workers.dev", "reuse"],
      ["password", "skip"],
    ]);
    api.done();
  });

  it("stops before touching anything when the instance runs a newer version", async () => {
    const { code, terminal, api } = await deploy("deploy-version-gate");

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toContain("furea 0.9.0, newer than this installer (0.2.0)");
    expect(terminal.stderr.join("\n")).toContain("--allow-downgrade");
    api.done();
  });

  it("resumes an interrupted first install by reopening an expired asset upload session", async () => {
    const { code, terminal, sent, api } = await deploy("deploy-resume-asset-session");

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.stdout).toContain("assets  create  uploaded 2 files (upload session reopened)");
    expect(steps(terminal.stdout).slice(0, 3)).toEqual([
      ["database", "reuse"],
      ["kv", "reuse"],
      ["migrations", "skip"],
    ]);
    expect((await scriptUploads(sent))[0]!.metadata.assets).toMatchObject({ jwt: "JWT_3" });
    // Without a terminal the analytics token is only pointed at.
    expect(terminal.stdout).toContain("analytics-token  skip  add it later with: npx furea analytics-token");
    api.done();
  });

  it("retries the upload once without CLICKS when Analytics Engine is not enabled, and still succeeds", async () => {
    const { code, terminal, sent, api } = await deploy("deploy-analytics-engine-disabled");

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    const uploads = await scriptUploads(sent);
    expect(uploads).toHaveLength(2);
    const names = (u: (typeof uploads)[number]) => (u.metadata.bindings as Array<{ name: string }>).map((b) => b.name);
    expect(names(uploads[0]!)).toContain("CLICKS");
    expect(names(uploads[1]!)).toEqual(names(uploads[0]!).filter((name) => name !== "CLICKS"));
    expect(terminal.stdout).toContain(
      "analytics  skip  Analytics Engine is not enabled on this account: https://github.com/sunwjy/furea/blob/main/docs/analytics-engine.md",
    );
    expect(terminal.stdout.find((line) => line.startsWith("analytics-token  "))).toMatch(
      /^analytics-token {2}skip {2}click breakdowns need Analytics Engine first: https:\/\/github.com\/sunwjy\/furea\/blob\/main\/docs\/analytics-engine.md$/,
    );
    api.done();
  });

  it("stops on any other refusal of the script upload", async () => {
    const { code, terminal, api } = await deploy("deploy-script-rejected");

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toContain("Unexpected token (10021)");
    api.done();
  });

  it("names --workers-subdomain when the account has none and stdin is not a terminal", async () => {
    const { code, terminal } = await deploy("deploy-fresh-install");

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toContain("--workers-subdomain");
  });

  it("refuses an instance name workers.dev would not accept", async () => {
    const terminal = fakeTerminal({ interactive: false });

    const code = await runCli(["deploy", "--name=-furea"], {
      fetch: (() => Promise.reject(new Error("no request expected"))) as typeof fetch,
      env: {},
      configDir: mkdtempSync(join(tmpdir(), "furea-cli-")),
      io: terminal,
      installer: INSTALLER,
    });

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toContain('"-furea" is not a valid instance name');
  });
});
