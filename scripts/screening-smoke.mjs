#!/usr/bin/env node
// Smoke test for wayfinder ticket #27: can a Worker on a Workers Free account
//   1. ask 1.1.1.1 for Families over DoH and get `0.0.0.0` + EDE(16) for the
//      malware/phishing test domains (and a real answer for a clean one)?
//   2. look a URL up in the ~1.4 MB URLhaus `text_online` list held in one KV
//      value within the 10 ms CPU limit?
//   3. download that list and write it to KV from a Cron Trigger within the
//      same limit?
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/screening-smoke.mjs [--keep] [--samples=5] [--cron-wait=180] [--skip-cron]
//
// Token needs: Workers Scripts Edit, Workers KV Storage Edit (+ Account Settings
// Read for the plan check). The script creates a KV namespace and a Worker named
// `furea-screening-smoke`, enables its workers.dev route, opens a live tail to read
// per-invocation `cpuTime` / `wallTime` / `outcome`, and deletes everything again
// (unless --keep). Timers inside a Worker only advance across I/O, so CPU time is
// taken from the tail, never from the Worker's own clock.

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const keep = process.argv.includes("--keep");
const arg = (name, fallback) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const samples = arg("samples", 5);
const cronWait = arg("cron-wait", 180);
const skipCron = process.argv.includes("--skip-cron");
const scriptName = "furea-screening-smoke";
const API = "https://api.cloudflare.com/client/v4";
const LIST_URL = "https://urlhaus.abuse.ch/downloads/text_online/";

if (!token || !accountId) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(2);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const step = (name, data) => console.log(`\n## ${name}\n${JSON.stringify(data, null, 2)}`);

async function cf(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}
const cfJson = (method, path, value) => cf(method, path, JSON.stringify(value), { "Content-Type": "application/json" });

// 1. Token, plan, workers.dev subdomain
// `cfat_` account tokens verify under the account, user tokens under /user.
let verify = await cf("GET", `/accounts/${accountId}/tokens/verify`);
if (verify.status !== 200) verify = await cf("GET", "/user/tokens/verify");
step("token verify", { status: verify.status, result: verify.json.result, errors: verify.json.errors });

const subs = await cf("GET", `/accounts/${accountId}/subscriptions`);
step("subscriptions (no Workers Paid line => Free plan)", {
  status: subs.status,
  subscriptions: (subs.json.result ?? []).map((s) => ({ product: s.rate_plan?.public_name ?? s.rate_plan?.id, state: s.state, price: s.price })),
  errors: subs.json.errors,
});

const sub = await cf("GET", `/accounts/${accountId}/workers/subdomain`);
const subdomain = sub.json.result?.subdomain;
if (!subdomain) {
  step("workers.dev subdomain", { status: sub.status, errors: sub.json.errors });
  console.error("No workers.dev subdomain registered on this account; register one in the dashboard first.");
  process.exit(1);
}

// 2. KV namespace + Worker
const ns = await cfJson("POST", `/accounts/${accountId}/storage/kv/namespaces`, { title: `${scriptName}-${Date.now()}` });
const namespaceId = ns.json.result?.id;
step("create KV namespace", { status: ns.status, namespaceId, errors: ns.json.errors });
if (!namespaceId) process.exit(1);

const workerSource = `
const LIST_URL = ${JSON.stringify(LIST_URL)};

async function refresh(env, mode) {
  const res = await fetch(LIST_URL);
  if (!res.ok) return { mode, listStatus: res.status };
  const length = Number(res.headers.get("content-length")) || null;
  if (mode === "stream") {
    await env.LIST.put("urlhaus", res.body, { metadata: { at: Date.now(), mode } });
  } else {
    await env.LIST.put("urlhaus", await res.arrayBuffer(), { metadata: { at: Date.now(), mode } });
  }
  return { mode, listStatus: res.status, contentLength: length };
}

// Line-bounded substring search: no copy of the 1.4 MB string, no parsing.
function containsLine(text, target) {
  let i = text.indexOf(target);
  while (i !== -1) {
    const before = i === 0 ? "\\n" : text[i - 1];
    const after = text[i + target.length];
    if (before === "\\n" && (after === undefined || after === "\\r" || after === "\\n")) return true;
    i = text.indexOf(target, i + 1);
  }
  return false;
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const t0 = Date.now();
    const colo = request.cf?.colo;
    if (u.pathname === "/doh") {
      const name = u.searchParams.get("name");
      const res = await fetch(
        "https://security.cloudflare-dns.com/dns-query?name=" + encodeURIComponent(name) + "&type=A",
        { headers: { accept: "application/dns-json" } },
      );
      const body = await res.json();
      return Response.json({
        name, colo, httpStatus: res.status, wallMs: Date.now() - t0,
        dnsStatus: body.Status, answer: (body.Answer ?? []).map((a) => a.data), comment: body.Comment ?? null,
      });
    }
    if (u.pathname === "/lookup") {
      const mode = u.searchParams.get("mode");
      const target = u.searchParams.get("url") ?? "";
      const text = await env.LIST.get("urlhaus", { type: "text", cacheTtl: 300 });
      const kvMs = Date.now() - t0;
      if (text === null) return Response.json({ error: "list not in KV" }, { status: 404 });
      let hit = null;
      if (mode === "substring") hit = containsLine(text, target);
      else if (mode === "set") hit = new Set(text.split("\\r\\n")).has(target);
      return Response.json({ mode, hit, chars: text.length, kvMs, colo });
    }
    if (u.pathname === "/refresh") {
      const out = await refresh(env, u.searchParams.get("mode") ?? "stream");
      return Response.json({ ...out, wallMs: Date.now() - t0, colo });
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env, "stream").then((out) => console.log(JSON.stringify({ cron: event.cron, ...out }))));
  },
};
`;
const metadata = {
  main_module: "index.mjs",
  compatibility_date: "2025-09-01",
  bindings: [{ type: "kv_namespace", name: "LIST", namespace_id: namespaceId }],
  observability: { enabled: false },
};
const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
form.append("index.mjs", new Blob([workerSource], { type: "application/javascript+module" }), "index.mjs");
const upload = await cf("PUT", `/accounts/${accountId}/workers/scripts/${scriptName}`, form);
step("upload Worker", { status: upload.status, success: upload.json.success, errors: upload.json.errors });
if (!upload.json.success) { await cleanup(); process.exit(1); }

const route = await cfJson("POST", `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, { enabled: true, previews_enabled: false });
step("enable workers.dev route", { status: route.status, success: route.json.success, errors: route.json.errors });

// 3. Live tail: collects cpuTime / wallTime / outcome per invocation
const tailEvents = [];
const tail = await cf("POST", `/accounts/${accountId}/workers/scripts/${scriptName}/tails`);
const tailId = tail.json.result?.id;
step("create tail", { status: tail.status, tailId, errors: tail.json.errors });
let ws;
if (tail.json.result?.url) {
  ws = new WebSocket(tail.json.result.url, "trace-v1");
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => ws.send(JSON.stringify({ debug: false })));
  ws.addEventListener("message", (m) => {
    const text = typeof m.data === "string" ? m.data : new TextDecoder().decode(m.data);
    try { tailEvents.push(JSON.parse(text)); } catch { /* ignore non-JSON frames */ }
  });
  await new Promise((res) => { ws.addEventListener("open", res); setTimeout(res, 10_000); });
}

const base = `https://${scriptName}.${subdomain}.workers.dev`;
for (let attempt = 0; attempt < 12; attempt++) {
  const r = await fetch(`${base}/warmup`);
  // Only the Worker's own plain-text 404 means the route is live; the edge answers
  // an HTML 404 page while the workers.dev route is still propagating.
  if (r.status === 404 && (await r.text()) === "not found") break;
  await sleep(5000);
}

async function call(path) {
  const t0 = performance.now();
  const res = await fetch(base + path);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { path, status: res.status, clientMs: Math.round(performance.now() - t0), ...body };
}

// 4. DoH from inside the Worker
const dohResults = [];
for (const name of ["example.com", "malware.testcategory.com", "phishing.testcategory.com"]) {
  for (let i = 0; i < samples; i++) dohResults.push(await call(`/doh?name=${name}`));
}
step("DoH lookups (expect 0.0.0.0 + EDE(16) for the test domains)", dohResults);

// 5. Fill KV over HTTP (both put modes), then look URLs up
const refreshResults = [];
refreshResults.push(await call("/refresh?mode=arraybuffer"));
await sleep(1500); // KV: at most one write per second per key
refreshResults.push(await call("/refresh?mode=stream"));
step("refresh over HTTP (URLhaus download -> KV.put)", refreshResults);

const list = await (await fetch(LIST_URL)).text();
const lines = list.split("\r\n").filter((l) => l && !l.startsWith("#"));
const hitUrl = lines[Math.floor(lines.length / 2)];
const missUrl = "https://example.com/definitely-not-listed";
const lookupResults = [];
for (const [mode, url] of [["kvonly", missUrl], ["substring", hitUrl], ["substring", missUrl], ["set", hitUrl]]) {
  for (let i = 0; i < samples; i++) lookupResults.push(await call(`/lookup?mode=${mode}&url=${encodeURIComponent(url)}`));
}
step("lookups (kvonly = KV read baseline)", { hitUrl, lines: lines.length, results: lookupResults });

// 6. Cron Trigger refresh
if (!skipCron) {
const sched = await cfJson("PUT", `/accounts/${accountId}/workers/scripts/${scriptName}/schedules`, [{ cron: "* * * * *" }]);
step("set Cron Trigger (every minute)", { status: sched.status, success: sched.json.success, errors: sched.json.errors });
const deadline = Date.now() + cronWait * 1000;
while (Date.now() < deadline && !tailEvents.some((e) => e.event?.cron)) await sleep(5000);
await sleep(8000); // let the waitUntil finish and its tail event arrive
const kvKeys = await cf("GET", `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/keys`);
step("KV keys after Cron", { status: kvKeys.status, keys: kvKeys.json.result });
}

// 7. Tail summary
await sleep(5000);
const pick = (e) => ({
  what: e.event?.cron ? `cron ${e.event.cron}` : new URL(e.event?.request?.url ?? "http://x/?").pathname + new URL(e.event?.request?.url ?? "http://x/?").search.replace(/&url=.*/, ""),
  outcome: e.outcome,
  cpuTime: e.cpuTime ?? null,
  wallTime: e.wallTime ?? null,
  exceptions: e.exceptions?.map((x) => `${x.name}: ${x.message}`),
  logs: e.logs?.map((l) => l.message).flat(),
});
const rows = tailEvents.map(pick).filter((r) => r.what !== "/warmup");
step("tail events (cpuTime/wallTime in ms, outcome 'exceededCpu' = over the limit)", rows);
const groups = {};
for (const r of rows) (groups[r.what.replace(/\?name=.*/, "")] ??= []).push(r);
const summary = Object.fromEntries(Object.entries(groups).map(([k, v]) => {
  const cpu = v.map((r) => r.cpuTime).filter((n) => typeof n === "number").sort((a, b) => a - b);
  return [k, { n: v.length, outcomes: [...new Set(v.map((r) => r.outcome))], cpuMin: cpu[0] ?? null, cpuMedian: cpu[Math.floor(cpu.length / 2)] ?? null, cpuMax: cpu.at(-1) ?? null }];
}));
step("SUMMARY per endpoint", summary);

await cleanup();

async function cleanup() {
  if (ws) ws.close();
  if (tailId) await cf("DELETE", `/accounts/${accountId}/workers/scripts/${scriptName}/tails/${tailId}`);
  if (keep) return step("kept", { scriptName, namespaceId });
  const del = await cf("DELETE", `/accounts/${accountId}/workers/scripts/${scriptName}?force=true`);
  const delNs = await cf("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`);
  step("cleanup", { script: del.status, namespace: delNs.status });
}
