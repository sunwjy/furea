#!/usr/bin/env node
// Smoke test for wayfinder ticket #17: does a Workers Free account accept a
// `ratelimit` binding through the same multipart PUT the installer will use,
// and does the binding actually deny the sixth call?
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/rate-limit-smoke.mjs [--keep] [--calls=15]
//
// Counters are per Cloudflare location, so calls are grouped by `colo` in the
// report; the limit only trips once a single colo has seen more than `limit` calls.
//
// Token needs: Workers Scripts Edit (+ Account Settings Read for the plan check).
// The script uploads a throwaway Worker named `furea-ratelimit-smoke`, enables its
// workers.dev route, calls it six times and deletes it again (unless --keep).

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const keep = process.argv.includes("--keep");
const callCount = Number((process.argv.find((a) => a.startsWith("--calls=")) ?? "--calls=15").slice(8));
const scriptName = "furea-ratelimit-smoke";
const API = "https://api.cloudflare.com/client/v4";

if (!token || !accountId) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(2);
}

const headers = { Authorization: `Bearer ${token}` };
const report = { steps: [] };
const step = (name, data) => {
  report.steps.push({ name, ...data });
  console.log(`\n## ${name}\n${JSON.stringify(data, null, 2)}`);
};

async function cf(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// 1. Token + account + plan
const verify = await cf("GET", "/user/tokens/verify");
step("token verify", { status: verify.status, result: verify.json.result, errors: verify.json.errors });

const account = await cf("GET", `/accounts/${accountId}`);
step("account", { status: account.status, name: account.json.result?.name, errors: account.json.errors });

const subs = await cf("GET", `/accounts/${accountId}/subscriptions`);
const subSummary = (subs.json.result ?? []).map((s) => ({
  product: s.rate_plan?.public_name ?? s.rate_plan?.id,
  state: s.state,
  price: s.price,
  currency: s.currency,
}));
step("subscriptions (empty or no Workers Paid line => Free plan)", {
  status: subs.status,
  subscriptions: subSummary,
  errors: subs.json.errors,
});

const wsub = await cf("GET", `/accounts/${accountId}/workers/subscription`);
step("workers subscription probe (404/empty => no Workers Paid subscription)", { status: wsub.status, result: wsub.json.result, errors: wsub.json.errors });
const settings = await cf("GET", `/accounts/${accountId}/workers/account-settings`);
step("workers account settings", { status: settings.status, result: settings.json.result, errors: settings.json.errors });

const sub = await cf("GET", `/accounts/${accountId}/workers/subdomain`);
const subdomain = sub.json.result?.subdomain;
step("workers.dev subdomain", { status: sub.status, subdomain, errors: sub.json.errors });
if (!subdomain) {
  console.error("No workers.dev subdomain registered on this account; register one in the dashboard first.");
  process.exit(1);
}

// 2. Upload the Worker with one ratelimit binding
const workerSource = `export default {
  async fetch(request, env) {
    const key = new URL(request.url).searchParams.get("key") ?? "default";
    const t0 = Date.now();
    const outcome = await env.LOGIN_IP.limit({ key });
    return Response.json({ key, success: outcome.success, colo: request.cf?.colo, ms: Date.now() - t0 });
  },
};
`;
const metadata = {
  main_module: "index.mjs",
  compatibility_date: "2025-09-01",
  bindings: [
    { type: "ratelimit", name: "LOGIN_IP", namespace_id: "1001", simple: { limit: 5, period: 60 } },
  ],
};
const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
form.append("index.mjs", new Blob([workerSource], { type: "application/javascript+module" }), "index.mjs");

const upload = await cf("PUT", `/accounts/${accountId}/workers/scripts/${scriptName}`, form);
step("upload (PUT multipart with ratelimit binding)", {
  status: upload.status,
  success: upload.json.success,
  errors: upload.json.errors,
  messages: upload.json.messages,
  bindings: upload.json.result?.bindings,
});
if (!upload.json.success) {
  console.error("\nUPLOAD REJECTED. Paste the block above into the ticket.");
  process.exit(1);
}

// 3. Enable workers.dev route
const route = await cf(
  "POST",
  `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
  JSON.stringify({ enabled: true, previews_enabled: false }),
  { "Content-Type": "application/json" },
);
step("enable workers.dev route", { status: route.status, success: route.json.success, errors: route.json.errors });

// 4. Call it six times with one fresh key
const url = `https://${scriptName}.${subdomain}.workers.dev/`;
const key = `smoke-${Date.now()}`;
const calls = [];
// workers.dev routes take a moment to propagate.
for (let attempt = 0; attempt < 12; attempt++) {
  const r = await fetch(`${url}?key=warmup-${Date.now()}`);
  if (r.status === 200) break;
  await new Promise((res) => setTimeout(res, 5000));
}
for (let i = 1; i <= callCount; i++) {
  const res = await fetch(`${url}?key=${key}`);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  calls.push({ call: i, status: res.status, ...body });
}
const perColo = {};
for (const c of calls) (perColo[c.colo] ??= []).push(c.success);
step(`${callCount} limit() calls, one key (expect the 6th call within one colo to be false)`, { url, key, calls, perColo });

// 5. Cleanup
if (!keep) {
  const del = await cf("DELETE", `/accounts/${accountId}/workers/scripts/${scriptName}?force=true`);
  step("delete script", { status: del.status, success: del.json.success, errors: del.json.errors });
} else {
  step("kept script", { scriptName });
}

const denied = calls.filter((c) => c.success === false).length;
console.log(`\n=== VERDICT: upload accepted; ${calls.length - denied} allowed, ${denied} denied ===`);
