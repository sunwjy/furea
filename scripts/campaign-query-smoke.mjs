#!/usr/bin/env node
// Smoke test for wayfinder ticket #34: does the Workers Analytics Engine SQL API
// accept the campaign query shape of ADR 0005 (section *Campaigns*) with one
// `(index1 = ? AND timestamp >= ?)` bound per link at the ADR 0012 cap of 100
// links, and where does it break?
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/campaign-query-smoke.mjs [--keep] [--sizes=100,250,500,1000,2000] [--repeat=3] [--ingest-wait=300]
//
// Token needs: Workers Scripts Edit (upload/delete the seeding Worker) and
// Account Analytics Read (SQL API). Set ANALYTICS_TOKEN to use a separate
// read-only token for the SQL calls instead.
//
// The script uploads a throwaway Worker named `furea-campaign-query-smoke` with an
// `analytics_engine` binding to the dataset `furea_campaign_smoke`, enables its
// workers.dev route, has it write clicks for 100 slugs shaped like ADR 0005's data
// point, waits until the rows are queryable, then sends the series query
// (`GROUP BY index1, bucket`, 90 d daily buckets) and the combined top-10 query
// with 100 bounds (repeated, timed) and with growing bound counts until one is
// refused. The Worker is deleted afterwards (unless --keep); the dataset cannot be
// deleted through the API and ages out with the 3-month retention.

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const analyticsToken = process.env.ANALYTICS_TOKEN ?? token;
const keep = process.argv.includes("--keep");
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const sizes = arg("sizes", "100,250,500,1000,2000").split(",").map(Number);
const repeat = Number(arg("repeat", 3));
const ingestWait = Number(arg("ingest-wait", 300));
const scriptName = "furea-campaign-query-smoke";
const dataset = "furea_campaign_smoke";
const API = "https://api.cloudflare.com/client/v4";
const SLUGS = 100;
const CLICKS_PER_SLUG = 3;
const TZ = "Asia/Seoul";

if (!token || !accountId) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(2);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const step = (name, data) => console.log(`\n## ${name}\n${JSON.stringify(data, null, 2)}`);

async function cf(method, path, body, extraHeaders = {}, bearer = token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...extraHeaders },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 2000) }; }
  return { status: res.status, json };
}

async function sql(query) {
  const t0 = performance.now();
  const res = await cf("POST", `/accounts/${accountId}/analytics_engine/sql`, query, { "Content-Type": "text/plain" }, analyticsToken);
  return { ...res, ms: Math.round(performance.now() - t0) };
}

// 1. Token + workers.dev subdomain
// Account-owned tokens (`cfat_…`) verify under the account, user tokens under /user.
const verify = await cf("GET", token.startsWith("cfat_") ? `/accounts/${accountId}/tokens/verify` : "/user/tokens/verify");
step("token verify", { status: verify.status, result: verify.json.result, errors: verify.json.errors });

const sub = await cf("GET", `/accounts/${accountId}/workers/subdomain`);
const subdomain = sub.json.result?.subdomain;
step("workers.dev subdomain", { status: sub.status, subdomain, errors: sub.json.errors });
if (!subdomain) {
  console.error("No workers.dev subdomain registered on this account; register one in the dashboard first.");
  process.exit(1);
}

// 2. Upload the seeding Worker. Data point layout follows ADR 0005:
// indexes [slug], blobs [slug, country, referrerHost, deviceClass], doubles [1].
const workerSource = `const COUNTRIES = ["KR", "US", "JP", "DE", "GB", "FR", "BR", "IN", "CA", "AU", "SG", "NL"];
const REFERRERS = ["", "t.co", "l.facebook.com", "www.instagram.com", "news.ycombinator.com", "mail.google.com"];
const DEVICES = ["desktop", "mobile", "tablet", "bot"];
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/seed") return new Response("furea-campaign-query-smoke");
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    const per = Number(url.searchParams.get("per"));
    let written = 0;
    for (let i = from; i < to; i++) {
      const slug = "cq" + String(i).padStart(3, "0");
      for (let k = 0; k < per; k++) {
        const n = i * per + k;
        env.CLICKS.writeDataPoint({
          indexes: [slug],
          blobs: [slug, COUNTRIES[n % COUNTRIES.length], REFERRERS[n % REFERRERS.length], DEVICES[n % DEVICES.length]],
          doubles: [1],
        });
        written++;
      }
    }
    return Response.json({ written });
  },
};
`;
const metadata = {
  main_module: "index.mjs",
  compatibility_date: "2025-09-01",
  bindings: [{ type: "analytics_engine", name: "CLICKS", dataset }],
};
const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
form.append("index.mjs", new Blob([workerSource], { type: "application/javascript+module" }), "index.mjs");

const upload = await cf("PUT", `/accounts/${accountId}/workers/scripts/${scriptName}`, form);
step("upload (PUT multipart with analytics_engine binding)", {
  status: upload.status,
  success: upload.json.success,
  errors: upload.json.errors,
  bindings: upload.json.result?.bindings,
});
if (!upload.json.success) {
  console.error("\nUPLOAD REJECTED. Paste the block above into the ticket.");
  process.exit(1);
}

const route = await cf(
  "POST",
  `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`,
  JSON.stringify({ enabled: true, previews_enabled: false }),
  { "Content-Type": "application/json" },
);
step("enable workers.dev route", { status: route.status, success: route.json.success, errors: route.json.errors });

try {
  await run();
} finally {
  // 7. Cleanup
  if (!keep) {
    const del = await cf("DELETE", `/accounts/${accountId}/workers/scripts/${scriptName}?force=true`);
    step("delete script", { status: del.status, success: del.json.success, errors: del.json.errors });
  } else {
    step("kept script", { scriptName });
  }
}

async function run() {
  // 3. Seed: 100 slugs x 3 clicks, 50 slugs per invocation (250 data points max per invocation).
  const base = `https://${scriptName}.${subdomain}.workers.dev`;
  // Wait for this upload (not an older version, e.g. a dashboard-made one) to serve.
  let live = false;
  for (let attempt = 0; attempt < 24 && !live; attempt++) {
    const r = await fetch(`${base}/`);
    live = r.status === 200 && (await r.text()) === "furea-campaign-query-smoke";
    if (!live) await sleep(5000);
  }
  if (!live) {
    process.exitCode = 1;
    console.error("\nThe uploaded version never answered on workers.dev.");
    return;
  }
  const seeded = [];
  for (let from = 0; from < SLUGS; from += 50) {
    const r = await fetch(`${base}/seed?from=${from}&to=${Math.min(from + 50, SLUGS)}&per=${CLICKS_PER_SLUG}`);
    seeded.push({ status: r.status, body: await r.text() });
  }
  const seedStart = new Date();
  step("seed", { slugs: SLUGS, clicksPerSlug: CLICKS_PER_SLUG, calls: seeded });

  // 4. Wait until every seeded row is queryable.
  const expected = SLUGS * CLICKS_PER_SLUG;
  let seen = 0;
  const deadline = Date.now() + ingestWait * 1000;
  while (Date.now() < deadline) {
    const r = await sql(`SELECT count() AS n FROM ${dataset} WHERE timestamp >= NOW() - INTERVAL '1' HOUR`);
    seen = Number(r.json.data?.[0]?.n ?? 0);
    if (r.status !== 200) step("ingest poll error", { status: r.status, body: r.json });
    if (seen >= expected) break;
    await sleep(10000);
  }
  step("ingest", { expected, seen, waitedSeconds: Math.round((Date.now() - seedStart) / 1000) });
  if (seen === 0) {
    process.exitCode = 1;
    console.error("\nNo rows became queryable; the query checks below would prove nothing.");
    return;
  }

  // 5. Query shapes. Real slugs get a created_at bound 1-30 days in the past, except
  // cq000 whose bound lies in the future: its clicks must drop out of every result.
  // Beyond 100, synthetic slugs with no data pad the bound list.
  const fmt = (d) => d.toISOString().slice(0, 19).replace("T", " ");
  const esc = (s) => s.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const boundsFor = (n) => {
    const parts = [];
    for (let i = 0; i < n; i++) {
      const slug = i < SLUGS ? `cq${String(i).padStart(3, "0")}` : `pad-${i}-${"x".repeat(20)}`;
      const createdAt = i === 0 ? new Date(Date.now() + 86400000) : new Date(Date.now() - ((i % 30) + 1) * 86400000);
      parts.push(`(index1 = '${esc(slug)}' AND timestamp >= toDateTime('${fmt(createdAt)}'))`);
    }
    return parts.join("\n   OR ");
  };
  const range = `timestamp >= NOW() - INTERVAL '90' DAY`;
  const seriesQuery = (n) => `SELECT index1 AS slug,
       toStartOfInterval(timestamp, INTERVAL '1' DAY, '${TZ}') AS bucket,
       sum(_sample_interval) AS clicks,
       count() AS rows_read
FROM ${dataset}
WHERE (${boundsFor(n)})
  AND ${range}
GROUP BY slug, bucket
ORDER BY slug, bucket`;
  const topQuery = (n) => `SELECT blob2 AS country, sum(_sample_interval) AS clicks, count() AS rows_read
FROM ${dataset}
WHERE (${boundsFor(n)})
  AND ${range}
GROUP BY country
ORDER BY clicks DESC
LIMIT 10`;

  const summarize = (r, kind) => {
    const data = r.json.data ?? [];
    const out = { status: r.status, ms: r.ms, rows: r.json.rows ?? data.length };
    if (r.status !== 200) out.error = r.json.raw ?? r.json.errors ?? r.json;
    if (kind === "series" && r.status === 200) {
      out.slugs = new Set(data.map((d) => d.slug)).size;
      out.clicks = data.reduce((s, d) => s + Number(d.clicks), 0);
      out.futureBoundExcluded = !data.some((d) => d.slug === "cq000");
    }
    if (kind === "top" && r.status === 200) {
      out.clicks = data.reduce((s, d) => s + Number(d.clicks), 0);
      out.top = data.slice(0, 3);
    }
    return out;
  };

  // 6a. 100 bounds, repeated and timed.
  const expectedClicks = (SLUGS - 1) * CLICKS_PER_SLUG;
  const at100 = [];
  for (let i = 0; i < repeat; i++) {
    at100.push({ run: i + 1, series: summarize(await sql(seriesQuery(100)), "series"), top: summarize(await sql(topQuery(100)), "top") });
  }
  step(`100 bounds (series SQL ${seriesQuery(100).length} bytes, top SQL ${topQuery(100).length} bytes; expect 99 slugs, ${expectedClicks} clicks)`, { runs: at100 });

  // 6b. Headroom: growing bound counts until one is refused.
  const headroom = [];
  for (const n of sizes.filter((s) => s !== 100)) {
    const q = seriesQuery(n);
    const r = summarize(await sql(q), "series");
    headroom.push({ bounds: n, sqlBytes: q.length, ...r });
    if (r.status !== 200) break;
  }
  step("headroom (series query)", { headroom });

  const ok100 = at100.every((r) => r.series.status === 200 && r.top.status === 200);
  const ms = at100.flatMap((r) => [r.series.ms, r.top.ms]);
  const firstFail = headroom.find((h) => h.status !== 200);
  console.log(
    `\n=== VERDICT: 100 bounds ${ok100 ? "accepted" : "REFUSED"} (${Math.min(...ms)}-${Math.max(...ms)} ms); ` +
      `${firstFail ? `first refusal at ${firstFail.bounds} bounds (${firstFail.sqlBytes} bytes)` : `no refusal up to ${Math.max(...sizes)} bounds`} ===`,
  );
}
