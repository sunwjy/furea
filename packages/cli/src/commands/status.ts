// `furea status`: what is deployed under the instance name and whether it still matches what `deploy` declares
// (ADR 0006 *Command surface*, ADR 0011). Drift and sync-pending links exit non-zero; a missing CLICKS binding is
// information, and the update check's line never changes the exit code. Read-only: nothing is created or fixed.

import { readFileSync } from "node:fs";
import type { WorkerManifest } from "@furea/shared";
import { type Binding, CloudflareClient } from "../cloudflare/client.ts";
import type { CommandContext } from "../context.ts";
import { resolveDeployCredentials } from "../credentials.ts";
import { verifyDeployToken } from "../deploy-token.ts";
import { CliError } from "../io.ts";
import { ANALYTICS_ENGINE_DOCS } from "../links.ts";
import type { Installer } from "../package-files.ts";
import { latestRelease, statusUpdateLine } from "../update-check.ts";
import { OBSERVABILITY } from "./deploy.ts";

export interface StatusOptions {
  installer: Installer;
  /** For the registry lookup only; the Cloudflare API goes through `ctx.fetch`. */
  registryFetch: typeof fetch;
  noUpdateCheck: boolean;
}

/** Returns the exit code: 0 when nothing is wrong, 1 on drift or sync-pending links. */
export async function status(ctx: CommandContext, options: StatusOptions): Promise<number> {
  const { io, name } = ctx;
  const { installer } = options;
  const manifest = JSON.parse(readFileSync(installer.files.workerManifest, "utf8")) as WorkerManifest;
  const { token, accountId } = await resolveDeployCredentials(ctx);
  const client = new CloudflareClient({ token, fetch: ctx.fetch });
  await verifyDeployToken(client, token, accountId);

  const database = await client.findD1Database(accountId, name);
  const kv = await client.findKvNamespace(accountId, name);
  const settings = await client.getScriptSettings(accountId, name);
  if (!settings) throw new CliError(`No instance named "${name}" on this account. Install it with: npx furea deploy`);

  const drift: string[] = [];
  const info: string[] = [];
  const line = (label: string, value: string) => io.out(`${label.padEnd(10)} ${value}`);

  // Bindings, against the set deploy declares from the manifest.
  const { bindings } = settings;
  const deployedVersion = plainText(bindings, "FUREA_VERSION");
  drift.push(...bindingDrift(manifest, bindings, database?.uuid, kv?.id, name));
  if (!bindings.some((b) => b.type === "analytics_engine" && b.name === manifest.bindings.analytics_engine.name)) {
    info.push(`no ${manifest.bindings.analytics_engine.name} binding (Analytics Engine is not enabled on this account): ${ANALYTICS_ENGINE_DOCS}`);
  }
  const observability = observabilityDrift(settings.observability);
  if (observability) drift.push(`observability differs from what deploy declares: ${observability}`);

  // Cron Trigger.
  const crons = await client.getSchedules(accountId, name);
  for (const cron of manifest.crons) if (!crons.includes(cron)) drift.push(`Cron Trigger ${cron} is missing`);

  // Hostname: a custom domain, else workers.dev.
  const domains = await client.listWorkerDomains(accountId, { service: name });
  let hostname: string | undefined;
  if (domains.length > 0) hostname = domains.map((d) => `https://${d.hostname}`).join(", ");
  else {
    const subdomain = await client.getAccountSubdomain(accountId);
    const route = subdomain === undefined ? { enabled: false } : await client.getScriptSubdomain(accountId, name);
    if (subdomain !== undefined && route.enabled) hostname = `https://${name}.${subdomain}.workers.dev (workers.dev)`;
  }
  if (hostname === undefined) drift.push("no hostname: neither a custom domain nor workers.dev is attached");

  // Sync-pending links (ADR 0011), counted in D1 through the deploy token.
  let pending: number | undefined;
  if (database) {
    const [counted] = await client.d1Query<{ pending: number }>(
      accountId,
      database.uuid,
      "SELECT COUNT(*) AS pending FROM links WHERE cache_synced = 0",
    );
    pending = Number(counted?.results[0]?.pending ?? 0);
    if (pending > 0) {
      drift.push(
        `${pending} link${pending === 1 ? " is" : "s are"} sync pending; the Cron Trigger retries them every 5 minutes, or use Retry now in the admin`,
      );
    }
  }

  line("instance", `${name} (account ${accountId})`);
  line("version", deployedVersion ?? "unknown (no FUREA_VERSION binding)");
  line("hostname", hostname ?? "none");
  line("database", database ? `${name} (${database.uuid})` : "missing");
  line("kv", kv ? `${name} (${kv.id})` : "missing");
  line("cron", crons.length > 0 ? crons.join(", ") : "none");
  if (pending !== undefined) line("sync", pending === 0 ? "no links pending" : `${pending} link${pending === 1 ? "" : "s"} pending`);
  for (const message of info) line("analytics", message);
  for (const message of drift) line("drift", message);
  io.out(drift.length === 0 ? "No drift." : "Drift found: run npx furea deploy to re-declare the instance.");

  // The update check: one line, whatever it says the exit code stays.
  if (deployedVersion !== undefined) {
    const latest = await latestRelease({ fetch: options.registryFetch, env: ctx.env, skip: options.noUpdateCheck });
    io.out(statusUpdateLine(deployedVersion, installer.version, latest));
  }
  return drift.length === 0 ? 0 : 1;
}

function plainText(bindings: Binding[], name: string): string | undefined {
  const binding = bindings.find((b) => b.type === "plain_text" && b.name === name);
  return typeof binding?.text === "string" ? binding.text : undefined;
}

function bindingDrift(
  manifest: WorkerManifest,
  bindings: Binding[],
  databaseId: string | undefined,
  kvId: string | undefined,
  name: string,
): string[] {
  const drift: string[] = [];
  if (databaseId === undefined) drift.push(`the D1 database ${name} is missing`);
  if (kvId === undefined) drift.push(`the KV namespace ${name} is missing`);
  const declared: Array<{ type: string; name: string; key?: string; id?: string | undefined; what?: string }> = [
    { type: "d1", name: manifest.bindings.d1, key: "id", id: databaseId, what: "database" },
    { type: "kv_namespace", name: manifest.bindings.kv, key: "namespace_id", id: kvId, what: "KV namespace" },
    { type: "assets", name: manifest.bindings.assets },
    ...manifest.bindings.ratelimits.map((r) => ({ type: "ratelimit", name: r.name })),
    ...manifest.bindings.plain_text.map((p) => ({ type: "plain_text", name: p })),
  ];
  for (const want of declared) {
    const found = bindings.find((b) => b.type === want.type && b.name === want.name);
    if (!found) drift.push(`binding ${want.name} (${want.type}) is missing`);
    else if (want.key && want.id !== undefined && found[want.key] !== want.id) {
      drift.push(`binding ${want.name} points at ${String(found[want.key])}, not the ${want.what} ${name} (${want.id})`);
    }
  }
  return drift;
}

/**
 * The first declared observability setting that differs, or undefined when they all match. A leaf Cloudflare does
 * not echo back is not counted: the settings response is not documented to repeat every field of the upload.
 */
function observabilityDrift(actual: Record<string, unknown> | undefined): string | undefined {
  if (actual === undefined || actual === null) return "not set";
  const differences: string[] = [];
  const walk = (want: Record<string, unknown>, got: Record<string, unknown>, path: string) => {
    for (const [key, value] of Object.entries(want)) {
      const at = path ? `${path}.${key}` : key;
      const seen = got[key];
      if (seen === undefined) continue;
      if (value !== null && typeof value === "object") {
        if (seen !== null && typeof seen === "object") walk(value as Record<string, unknown>, seen as Record<string, unknown>, at);
        else differences.push(`${at} is ${JSON.stringify(seen)}`);
      } else if (seen !== value) differences.push(`${at} is ${JSON.stringify(seen)}, expected ${JSON.stringify(value)}`);
    }
  };
  walk(OBSERVABILITY, actual, "");
  return differences.length > 0 ? differences.join("; ") : undefined;
}
