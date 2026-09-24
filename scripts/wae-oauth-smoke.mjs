#!/usr/bin/env node
// Smoke test for wayfinder ticket #23: does the Workers Analytics Engine SQL API
// accept the OAuth access token of a logged-in wrangler session?
//
// Usage (after `npx wrangler login`):
//   node scripts/wae-oauth-smoke.mjs [--account=<id>]
//
// The token comes from `npx wrangler auth token --json` and is never printed;
// the report holds only status codes, error bodies and the session's scopes.
// Without --account (or CLOUDFLARE_ACCOUNT_ID) the first account the token can
// list is used.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.cloudflare.com/client/v4";
const argAccount = process.argv.find((a) => a.startsWith("--account="))?.slice(10);

const raw = execFileSync("npx", ["-y", "wrangler@latest", "auth", "token", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const parsed = JSON.parse(raw.slice(raw.indexOf("{")));
const token = parsed.token ?? parsed.oauth_token ?? parsed.access_token;
if (!token) {
  console.error(`No token field in wrangler output (keys: ${Object.keys(parsed).join(", ")}).`);
  process.exit(2);
}

const step = (name, data) => console.log(`\n## ${name}\n${JSON.stringify(data, null, 2)}`);

step("wrangler auth token", {
  type: parsed.type ?? null,
  keys: Object.keys(parsed),
  scopes: readScopes(),
});

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "text/plain" } : {}) },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text: json ? undefined : text.slice(0, 2000) };
}

let accountId = argAccount ?? process.env.CLOUDFLARE_ACCOUNT_ID;
if (!accountId) {
  const accounts = await call("GET", "/accounts?per_page=5");
  step("GET /accounts", {
    status: accounts.status,
    count: accounts.json?.result?.length,
    errors: accounts.json?.errors,
  });
  accountId = accounts.json?.result?.[0]?.id;
  if (!accountId) {
    console.error("Could not resolve an account id; pass --account=<id>.");
    process.exit(2);
  }
}

const sql = (query) => call("POST", `/accounts/${accountId}/analytics_engine/sql`, query);

const show = await sql("SHOW TABLES");
step("SHOW TABLES", { status: show.status, body: show.json ?? show.text });

const tables = show.json?.data?.map((row) => row.dataset ?? Object.values(row)[0]) ?? [];
const dataset = tables[0] ?? "furea_smoke_nonexistent";
const select = await sql(`SELECT count() AS n FROM ${dataset}`);
step(`SELECT count() FROM ${dataset}${tables[0] ? "" : " (no dataset listed)"}`, {
  status: select.status,
  body: select.json ?? select.text,
});

function readScopes() {
  const candidates = [
    join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ".wrangler/config/default.toml"),
    join(homedir(), ".wrangler/config/default.toml"),
  ];
  for (const file of candidates) {
    try {
      const match = readFileSync(file, "utf8").match(/^scopes = \[(.*)\]$/m);
      if (match) return JSON.parse(`[${match[1]}]`);
    } catch {}
  }
  return null;
}
