import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeployOutput, runIntegration, staleInstances } from "./integration.mjs";

const NOW = new Date("2026-10-16T12:00:00Z");

test("the sweep picks furea-ci-* instances created more than a day ago, once each", () => {
  const names = staleInstances(
    [
      { name: "furea-ci-aaaaaaa", createdAt: "2026-10-15T11:59:59Z" },
      { name: "furea-ci-aaaaaaa", createdAt: "2026-10-15T10:00:00Z" },
      { name: "furea-ci-bbbbbbb", createdAt: "2026-10-15T12:00:01Z" },
      { name: "furea", createdAt: "2026-01-01T00:00:00Z" },
      { name: "my-furea-ci-x", createdAt: "2026-01-01T00:00:00Z" },
      { name: "furea-ci-ccccccc", createdAt: undefined },
    ],
    NOW,
  );
  assert.deepEqual(names, ["furea-ci-aaaaaaa"]);
});

const FIRST_INSTALL = `database  create  furea-ci-1a2b3c4 (0b6d5c1e-0000-4000-8000-000000000001)
kv  create  furea-ci-1a2b3c4 (5f2c0000000000000000000000000001)
migrations  create  applied 0001_init.sql, 0002_campaigns.sql
assets  create  uploaded 14 files
script  create  furea@0.2.0
analytics  skip  Analytics Engine is not enabled on this account: https://example.com/docs
cron  create  */5 * * * *
workers.dev  create  https://furea-ci-1a2b3c4.ci-sub.workers.dev
password  create  AbCdEfGhJkMnPqRsTuVwXyZ2  (shown only this once; store it now)
analytics-token  skip  add it later with: npx furea analytics-token
Ready: https://furea-ci-1a2b3c4.ci-sub.workers.dev/admin/
A newer furea is published: run npx furea@latest deploy`;

test("a deploy transcript yields its URL, the first-install password and every step's action", () => {
  const parsed = parseDeployOutput(FIRST_INSTALL);
  assert.equal(parsed.url, "https://furea-ci-1a2b3c4.ci-sub.workers.dev");
  assert.equal(parsed.password, "AbCdEfGhJkMnPqRsTuVwXyZ2");
  assert.deepEqual(
    parsed.steps.map((s) => `${s.step}:${s.action}`),
    [
      "database:create",
      "kv:create",
      "migrations:create",
      "assets:create",
      "script:create",
      "analytics:skip",
      "cron:create",
      "workers.dev:create",
      "password:create",
      "analytics-token:skip",
    ],
  );
});

test("a re-deploy has no password, and a transcript without a Ready line is an error", () => {
  const redeploy = parseDeployOutput("password  skip  already set; npx furea reset-password replaces it\nReady: https://a.b.workers.dev/admin/");
  assert.equal(redeploy.password, undefined);
  assert.equal(redeploy.url, "https://a.b.workers.dev");
  assert.throws(() => parseDeployOutput("database  create  x"), /no "Ready:" line/);
});

// ---- runIntegration, against a fake CLI and a fake instance at the HTTP boundary ----

const NAME = "furea-ci-1a2b3c4";
const ORIGIN = `https://${NAME}.ci-sub.workers.dev`;

/** An instance as the smoke set sees it over HTTP: the deployed version, one password, links that redirect. */
function fakeInstance() {
  const state = { version: undefined, password: undefined, links: new Map(), statsStatus: 503, redirects: [] };
  /** @type {typeof fetch} */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (state.version === undefined) return new Response("not deployed", { status: 404 });
    if (url.pathname === "/api/v1/openapi.json") return Response.json({ info: { version: state.version } });
    if (url.pathname === "/api/v1/auth/login" && method === "POST") {
      const { password } = JSON.parse(String(init.body));
      if (password !== state.password) return new Response("nope", { status: 401 });
      return new Response(null, { status: 204, headers: { "set-cookie": "furea_session=s; Path=/" } });
    }
    if (url.pathname === "/api/v1/links" && method === "POST") {
      const { slug, destination } = JSON.parse(String(init.body));
      state.links.set(slug, destination);
      return Response.json({ slug, destination }, { status: 201 });
    }
    if (url.pathname === "/api/v1/links") {
      return Response.json({ items: [...state.links.keys()].map((slug) => ({ slug })) });
    }
    if (/^\/api\/v1\/links\/[^/]+\/stats$/.test(url.pathname)) {
      const code = state.statsStatus === 503 ? "analytics_unavailable" : "ok";
      return Response.json({ error: { code } }, { status: state.statsStatus });
    }
    const slug = url.pathname.slice(1);
    const destination = state.links.get(slug);
    if (!destination) return new Response("not found", { status: 404 });
    state.redirects.push(`${state.version} /${slug}`);
    return new Response(null, { status: 302, headers: { location: destination } });
  };
  return { state, fetch };
}

/** A furea build as the integration sees it: `run(args)` deploys to, reports on or destroys the fake instance. */
function fakeCli(version, instance, calls, overrides = {}) {
  let deploys = 0;
  return {
    version,
    async run(args) {
      calls.push(`${version} ${args.join(" ")}`);
      const command = args[0];
      const override = overrides[command]?.({ deploys });
      if (command === "deploy") deploys++;
      if (override) return override;
      if (command === "deploy") {
        const first = instance.state.version === undefined;
        const upgrade = instance.state.version !== version;
        instance.state.version = version;
        const lines = [`database  ${first ? "create" : "reuse"}  ${NAME} (uuid)`, `script  ${upgrade ? "create" : "reuse"}  furea@${version}`];
        if (first) {
          instance.state.password = `pw-${version}`;
          lines.push(`password  create  ${instance.state.password}  (shown only this once; store it now)`);
        } else lines.push("password  skip  already set; npx furea reset-password replaces it");
        lines.push(`Ready: ${ORIGIN}/admin/`);
        return { code: 0, stdout: lines.join("\n"), stderr: "" };
      }
      if (command === "status") {
        return { code: 0, stdout: `instance   ${NAME} (account A)\nversion    ${instance.state.version}\nNo drift.`, stderr: "" };
      }
      if (command === "destroy") {
        instance.state.version = undefined;
        return { code: 0, stdout: "destroyed", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command}` };
    },
  };
}

const STALE = [{ name: "furea-ci-old0000", createdAt: "2026-10-14T00:00:00Z" }];

function setup({ candidate, noLatest = false, listResources = async () => STALE } = {}) {
  const instance = fakeInstance();
  const calls = [];
  const lines = [];
  return {
    instance,
    calls,
    lines,
    options: {
      name: NAME,
      candidate: fakeCli("0.2.0", instance, calls, candidate),
      latest: noLatest ? null : fakeCli("0.1.0", instance, calls),
      fetch: instance.fetch,
      listResources,
      now: () => NOW,
      sleep: async () => {},
      log: (line) => lines.push(line),
    },
  };
}

const DESTROY = `0.2.0 destroy --name ${NAME} --confirm ${NAME}`;

test("it sweeps, installs latest, upgrades to the candidate, re-deploys and destroys, in that order", async () => {
  const { calls, options } = setup();
  await runIntegration(options);
  assert.deepEqual(calls, [
    "0.2.0 destroy --name furea-ci-old0000 --confirm furea-ci-old0000",
    `0.1.0 deploy --name ${NAME} --workers-dev --no-update-check`,
    `0.2.0 deploy --name ${NAME} --workers-dev --no-update-check`,
    `0.2.0 status --name ${NAME} --no-update-check`,
    `0.2.0 deploy --name ${NAME} --workers-dev --no-update-check`,
    DESTROY,
  ]);
});

test("the link created under latest still redirects once the candidate is deployed", async () => {
  const { instance, options } = setup();
  await runIntegration(options);
  const [oldSlug] = [...instance.state.links.keys()];
  assert.deepEqual(
    instance.state.redirects.filter((r) => r.endsWith(`/${oldSlug}`)),
    [`0.1.0 /${oldSlug}`, `0.2.0 /${oldSlug}`],
  );
});

test("with nothing published it installs the candidate fresh and logs in with its password", async () => {
  const { calls, options } = setup({ noLatest: true });
  await runIntegration(options);
  assert.deepEqual(calls.slice(1), [
    `0.2.0 deploy --name ${NAME} --workers-dev --no-update-check`,
    `0.2.0 status --name ${NAME} --no-update-check`,
    `0.2.0 deploy --name ${NAME} --workers-dev --no-update-check`,
    DESTROY,
  ]);
});

test("a re-deploy that creates anything fails the run naming the step, and destroy still runs", async () => {
  const { calls, options } = setup({
    candidate: {
      deploy: ({ deploys }) =>
        deploys === 1 ? { code: 0, stdout: `cron  create  */5 * * * *\nReady: ${ORIGIN}/admin/`, stderr: "" } : undefined,
    },
  });
  await assert.rejects(runIntegration(options), /second deploy is not idempotent: cron create/);
  assert.equal(calls.at(-1), DESTROY);
});

test("status reporting another version fails the run, and destroy still runs", async () => {
  const { calls, options } = setup({ candidate: { status: () => ({ code: 0, stdout: "version    0.1.0\nNo drift.", stderr: "" }) } });
  await assert.rejects(runIntegration(options), /status reports version 0\.1\.0, expected 0\.2\.0/);
  assert.equal(calls.at(-1), DESTROY);
});

test("stats answering anything but 503 analytics_unavailable fails the run", async () => {
  const { instance, options } = setup();
  instance.state.statsStatus = 200;
  await assert.rejects(runIntegration(options), /stats: expected 503 analytics_unavailable, got 200/);
});

test("a sweep that cannot list only warns", async () => {
  const { lines, options } = setup({ listResources: async () => Promise.reject(new Error("HTTP 500")) });
  await runIntegration(options);
  assert.ok(lines.some((l) => l.startsWith("warning: sweep: HTTP 500")));
});

test("a stale instance that will not destroy only warns, but the run's own destroy failing is a failure", async () => {
  const { lines, options } = setup({ candidate: { destroy: () => ({ code: 1, stdout: "", stderr: "boom" }) } });
  await assert.rejects(runIntegration(options), /destroy furea-ci-1a2b3c4 failed/);
  assert.ok(lines.some((l) => l.startsWith("warning: sweep: destroy furea-ci-old0000 failed")));
});
