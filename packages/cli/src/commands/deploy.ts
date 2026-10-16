// `furea deploy` (the default command): install or upgrade an instance on workers.dev, in the step order of
// ADR 0006. Every resource is found by instance name and every setting is re-declared, so running it again
// is both the upgrade and the recovery from any failure. Each step prints one `create` / `reuse` / `skip` line.

import { readFileSync } from "node:fs";
import type { WorkerManifest } from "@furea/shared";
// Subpath imports keep the API schemas (and zod) out of the CLI bundle.
import { hashPassword } from "@furea/shared/password";
import { randomAlphabetString } from "@furea/shared/slug";
import { readAssets, syncAssets, type AssetSync } from "../assets.ts";
import { type Binding, CloudflareApiError, CloudflareClient } from "../cloudflare/client.ts";
import type { CommandContext } from "../context.ts";
import { resolveDeployCredentials } from "../credentials.ts";
import { analyticsTokenTemplateUrl, verifyDeployToken } from "../deploy-token.ts";
import { ask, CliError, type Io } from "../io.ts";
import { ANALYTICS_ENGINE_DOCS } from "../links.ts";
import { applyMigrations } from "../migrations.ts";
import type { Installer } from "../package-files.ts";
import { isNewer } from "../version.ts";
import { login } from "./login.ts";

export interface DeployOptions {
  installer: Installer;
  /** `--workers-subdomain`: the account-wide workers.dev subdomain to register when there is none. */
  workersSubdomain: string | undefined;
  allowDowngrade: boolean;
}

/** ADR 0011: declared on every upload, so the state never rests on Cloudflare's defaults or a dashboard edit. */
export const OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, invocation_logs: false, persist: true },
  traces: { enabled: false },
  redact_query_string: true,
};

/** Assets first (ADR 0001): no SPA fallback, so `/abc123` always reaches the Worker. */
const ASSETS_CONFIG = { not_found_handling: "none" };

/** Wrangler's error code for an upload carrying an `analytics_engine` binding on an account without it (ADR 0006). */
const ANALYTICS_ENGINE_DISABLED = 10089;

const PASSWORD_LENGTH = 24;

type Action = "create" | "reuse" | "skip";

function step(io: Io, name: string, action: Action, detail: string): void {
  io.out(`${name}  ${action}  ${detail}`);
}

export async function deploy(ctx: CommandContext, options: DeployOptions): Promise<void> {
  const { io, name } = ctx;
  const { installer } = options;
  const manifest = JSON.parse(readFileSync(installer.files.workerManifest, "utf8")) as WorkerManifest;

  // 1. Token and account.
  const { token, accountId } = await deployCredentials(ctx);
  const client = new CloudflareClient({ token, fetch: ctx.fetch });
  await verifyDeployToken(client, token, accountId);

  // 2. D1, KV and whatever script is deployed under the name.
  let database = await client.findD1Database(accountId, name);
  if (database) step(io, "database", "reuse", `${name} (${database.uuid})`);
  else {
    database = await client.createD1Database(accountId, name);
    step(io, "database", "create", `${name} (${database.uuid})`);
  }
  let kv = await client.findKvNamespace(accountId, name);
  if (kv) step(io, "kv", "reuse", `${name} (${kv.id})`);
  else {
    kv = await client.createKvNamespace(accountId, name);
    step(io, "kv", "create", `${name} (${kv.id})`);
  }
  const deployed = await client.getScriptBindings(accountId, name);
  const deployedVersion = deployed && plainText(deployed, "FUREA_VERSION");

  // 3. Version gate.
  const downgrade = deployedVersion !== undefined && isNewer(deployedVersion, installer.version);
  if (downgrade && !options.allowDowngrade) {
    throw new CliError(
      `The instance "${name}" runs furea ${deployedVersion}, newer than this installer (${installer.version}). ` +
        "Use npx furea@latest deploy, or pass --allow-downgrade to install the older version anyway.",
    );
  }

  // 4. Migrations, before the code that needs them; the old Worker keeps serving meanwhile.
  const applied = await applyMigrations(client, accountId, database.uuid, installer.files.migrations);
  if (applied.length > 0) step(io, "migrations", "create", `applied ${applied.join(", ")}`);
  else step(io, "migrations", "skip", "none pending");

  // 5. Admin assets.
  const assets = readAssets(installer.files.assetsRoot);
  let sync = await syncAssets(client, accountId, name, assets);
  if (sync.uploaded > 0) {
    const reopened = sync.reopened > 0 ? " (upload session reopened)" : "";
    step(io, "assets", "create", `uploaded ${sync.uploaded} file${sync.uploaded === 1 ? "" : "s"}${reopened}`);
  } else step(io, "assets", "reuse", `all ${assets.files.size} files already uploaded`);

  // 6. The script with the full declarative binding set; CLICKS is dropped only on 10089.
  const script = readFileSync(installer.files.workerScript, "utf8");
  const plainValues: Record<string, string> = { FUREA_VERSION: installer.version, FUREA_ACCOUNT_ID: accountId };
  const upload = (withClicks: boolean, assetSync: AssetSync) => {
    const metadata = {
      main_module: manifest.main_module,
      compatibility_date: manifest.compatibility_date,
      compatibility_flags: manifest.compatibility_flags,
      bindings: bindingsFor(manifest, { databaseId: database.uuid, kvId: kv.id, plainValues, withClicks }),
      keep_bindings: ["secret_text"],
      assets: { jwt: assetSync.jwt, config: { ...ASSETS_CONFIG, ...assets.config } },
      observability: OBSERVABILITY,
    };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata");
    form.append(manifest.main_module, new File([script], manifest.main_module, { type: "application/javascript+module" }));
    return client.putScript(accountId, name, form);
  };
  let clicks = true;
  try {
    await upload(true, sync);
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.hasCode(ANALYTICS_ENGINE_DISABLED))) throw error;
    clicks = false;
    // A fresh completion token for the second upload; Cloudflare already has every file, so this is one request.
    sync = await syncAssets(client, accountId, name, assets);
    await upload(false, sync);
  }
  const versionDetail =
    deployedVersion === undefined || deployedVersion === installer.version
      ? `${name} ${installer.version}`
      : `${name} ${deployedVersion} → ${installer.version}${downgrade ? " (downgrade allowed)" : ""}`;
  step(io, "script", deployed ? "reuse" : "create", versionDetail);
  if (!clicks) step(io, "analytics", "skip", `Analytics Engine is not enabled on this account: ${ANALYTICS_ENGINE_DOCS}`);

  // 7. Cron Trigger.
  const crons = await client.getSchedules(accountId, name);
  if (sameSet(crons, manifest.crons)) step(io, "cron", "reuse", manifest.crons.join(", "));
  else {
    await client.putSchedules(accountId, name, manifest.crons);
    step(io, "cron", "create", manifest.crons.join(", "));
  }

  // 8. Hostname: workers.dev.
  const url = await enableWorkersDev(ctx, client, accountId, options.workersSubdomain);

  // 9. Operator password, once: the insert does nothing when a hash is already stored.
  const password = randomAlphabetString(PASSWORD_LENGTH);
  const [inserted] = await client.d1Query(
    accountId,
    database.uuid,
    "INSERT INTO settings (key, value) VALUES ('operator_password_hash', ?) ON CONFLICT (key) DO NOTHING",
    [await hashPassword(password)],
  );
  const firstInstall = (inserted?.meta?.changes ?? 0) > 0;
  if (firstInstall) step(io, "password", "create", `${password}  (shown only this once; store it now)`);
  else step(io, "password", "skip", "already set; npx furea reset-password replaces it");

  // 10. Analytics token, offered on the first install only.
  if (firstInstall) await offerAnalyticsToken(ctx, client, accountId, clicks);

  io.out(`Ready: ${url}/admin/`);
}

/** Stored or environment credentials; on a first run at a terminal with none, the login flow. */
async function deployCredentials(ctx: CommandContext) {
  if (!ctx.env.CLOUDFLARE_API_TOKEN && Object.keys(ctx.credentials.read()).length === 0 && ctx.io.interactive) {
    await login(ctx, { accountToken: false });
  }
  return resolveDeployCredentials(ctx);
}

function plainText(bindings: Binding[], name: string): string | undefined {
  const binding = bindings.find((b) => b.type === "plain_text" && b.name === name);
  return typeof binding?.text === "string" ? binding.text : undefined;
}

interface BindingValues {
  databaseId: string;
  kvId: string;
  plainValues: Record<string, string>;
  withClicks: boolean;
}

/** The manifest's bindings in upload form (ADR 0007: the manifest is the only CLI-Worker contract). */
export function bindingsFor(manifest: WorkerManifest, values: BindingValues): Binding[] {
  const { bindings } = manifest;
  const plain = bindings.plain_text.map((bindingName) => {
    const text = values.plainValues[bindingName];
    if (text === undefined) throw new CliError(`The Worker expects a value for ${bindingName} that this installer cannot provide.`);
    return { type: "plain_text", name: bindingName, text };
  });
  return [
    { type: "d1", name: bindings.d1, id: values.databaseId },
    { type: "kv_namespace", name: bindings.kv, namespace_id: values.kvId },
    { type: "assets", name: bindings.assets },
    ...(values.withClicks
      ? [{ type: "analytics_engine", name: bindings.analytics_engine.name, dataset: bindings.analytics_engine.dataset }]
      : []),
    ...bindings.ratelimits.map((r) => ({ type: "ratelimit", name: r.name, namespace_id: r.namespace_id, simple: r.simple })),
    ...plain,
  ];
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);
}

async function enableWorkersDev(ctx: CommandContext, client: CloudflareClient, accountId: string, wanted: string | undefined): Promise<string> {
  let created = false;
  let subdomain = await client.getAccountSubdomain(accountId);
  if (subdomain === undefined) {
    // Account-wide and permanent-looking, so it is asked for rather than invented (ADR 0006).
    const choice =
      wanted ??
      (await ask(ctx.io, "No workers.dev subdomain on this account yet. Choose one (account-wide, <name>.workers.dev): ", "--workers-subdomain"));
    subdomain = await client.putAccountSubdomain(accountId, choice);
    created = true;
  }
  const current = await client.getScriptSubdomain(accountId, ctx.name);
  if (!current.enabled) {
    await client.setScriptSubdomain(accountId, ctx.name, { enabled: true, previews_enabled: false });
    created = true;
  }
  const url = `https://${ctx.name}.${subdomain}.workers.dev`;
  step(ctx.io, "workers.dev", created ? "create" : "reuse", url);
  return url;
}

async function offerAnalyticsToken(ctx: CommandContext, client: CloudflareClient, accountId: string, clicks: boolean): Promise<void> {
  const { io } = ctx;
  if (!clicks) {
    step(io, "analytics-token", "skip", `click breakdowns need Analytics Engine first: ${ANALYTICS_ENGINE_DOCS}`);
    return;
  }
  let token = ctx.env.FUREA_ANALYTICS_TOKEN;
  if (!token && io.interactive) {
    const answer = (await io.prompt("Set the analytics token now? It enables click breakdowns. [y/N] ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      const url = analyticsTokenTemplateUrl("user");
      io.out("Create a read-only analytics token with the pre-filled form (opening it in your browser):");
      io.out(`  ${url}`);
      await io.openUrl(url);
      token = await ask(io, "Paste the analytics token: ", "FUREA_ANALYTICS_TOKEN", { secret: true });
    }
  }
  if (!token) {
    step(io, "analytics-token", "skip", "add it later with: npx furea analytics-token");
    return;
  }
  await client.putSecret(accountId, ctx.name, "ANALYTICS_TOKEN", token);
  step(io, "analytics-token", "create", "stored as the ANALYTICS_TOKEN secret");
}
