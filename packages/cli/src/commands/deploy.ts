// `furea deploy` (the default command): install or upgrade an instance, in the step order of
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
import { verifyDeployToken } from "../deploy-token.ts";
import { CliError, step } from "../io.ts";
import { ANALYTICS_ENGINE_DOCS } from "../links.ts";
import { HOSTNAME_CHOICE_FLAGS, type HostnameChoice, resolveHostname } from "../hostname.ts";
import { applyMigrations } from "../migrations.ts";
import type { Installer } from "../package-files.ts";
import { deployUpdateLine, latestRelease } from "../update-check.ts";
import { isNewer } from "../version.ts";
import { pasteAnalyticsToken, storeAnalyticsToken } from "./analytics-token.ts";
import { login } from "./login.ts";

export interface DeployOptions {
  installer: Installer;
  /** `--hostname` / `--workers-dev` / `--workers-subdomain`: the first-run hostname choice (ADR 0006 step 8). */
  hostname: HostnameChoice;
  allowDowngrade: boolean;
  /** For the update check's registry lookup only; the Cloudflare API goes through `ctx.fetch`. */
  registryFetch: typeof fetch;
  /** `--no-update-check`. */
  noUpdateCheck: boolean;
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

/** ADR 0003: 24 characters from the slug alphabet. */
export const OPERATOR_PASSWORD_LENGTH = 24;

export async function deploy(ctx: CommandContext, options: DeployOptions): Promise<void> {
  const { io, name } = ctx;
  const { installer } = options;
  const manifest = JSON.parse(readFileSync(installer.files.workerManifest, "utf8")) as WorkerManifest;

  // 1. Token and account.
  const { token, accountId, loggedIn } = await deployCredentials(ctx);
  const client = new CloudflareClient({ token, fetch: ctx.fetch });
  await verifyDeployToken(client, token, accountId);
  step(io, "token", loggedIn ? "create" : "reuse", `verified for account ${accountId}`);

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
  if (!deployed && !io.interactive && !options.hostname.hostname && !options.hostname.workersDev) {
    // A first install needs the hostname choice; without a terminal, stop before anything is uploaded.
    throw new CliError(`First install of "${name}": pass ${HOSTNAME_CHOICE_FLAGS} (stdin is not a terminal, so nothing is prompted).`);
  }

  // 3. Version gate.
  const downgrade = deployedVersion !== undefined && isNewer(deployedVersion, installer.version);
  if (downgrade && !options.allowDowngrade) {
    throw new CliError(
      `The instance "${name}" runs furea ${deployedVersion}, newer than this installer (${installer.version}). ` +
        "Use npx furea@latest deploy, or pass --allow-downgrade to install the older version anyway.",
    );
  }
  step(io, "version", "skip", versionGateDetail(deployedVersion, installer.version, downgrade));

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

  // 8. Hostname: whatever is attached, else the first-run choice.
  const url = await resolveHostname(ctx, client, accountId, options.hostname, deployed !== undefined);

  // 9. Operator password, once: the insert does nothing when a hash is already stored.
  const password = randomAlphabetString(OPERATOR_PASSWORD_LENGTH);
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

  // A newer release than the one just deployed: a stale npx cache or a pinned CI installer (ADR 0006 *Update check*).
  const latest = await latestRelease({ fetch: options.registryFetch, env: ctx.env, skip: options.noUpdateCheck });
  const hint = deployUpdateLine(installer.version, latest);
  if (hint) io.out(hint);
}

/** Stored or environment credentials; on a first run at a terminal with none, the login flow (`loggedIn`). */
async function deployCredentials(ctx: CommandContext) {
  const loggedIn =
    !ctx.env.CLOUDFLARE_API_TOKEN && Object.keys(ctx.credentials.read()).length === 0 && ctx.io.interactive;
  if (loggedIn) await login(ctx, { accountToken: false });
  return { ...(await resolveDeployCredentials(ctx)), loggedIn };
}

/** The version gate passed: what it compared. */
function versionGateDetail(deployed: string | undefined, installing: string, downgrade: boolean): string {
  if (deployed === undefined) return `first install of ${installing}`;
  if (deployed === installing) return `${installing} already deployed`;
  return downgrade ? `downgrade from ${deployed} to ${installing} allowed` : `upgrade from ${deployed} to ${installing}`;
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

async function offerAnalyticsToken(ctx: CommandContext, client: CloudflareClient, accountId: string, clicks: boolean): Promise<void> {
  const { io } = ctx;
  if (!clicks) {
    step(io, "analytics-token", "skip", `click breakdowns need Analytics Engine first: ${ANALYTICS_ENGINE_DOCS}`);
    return;
  }
  let token = ctx.env.FUREA_ANALYTICS_TOKEN;
  if (!token && io.interactive) {
    const answer = (await io.prompt("Set the analytics token now? It enables click breakdowns. [y/N] ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") token = await pasteAnalyticsToken(ctx, "user");
  }
  if (!token) {
    step(io, "analytics-token", "skip", "add it later with: npx furea analytics-token");
    return;
  }
  try {
    await storeAnalyticsToken(ctx, client, accountId, token);
  } catch (error) {
    // The instance is installed by now; a bad analytics token must not turn the install into a failure.
    if (!(error instanceof CliError)) throw error;
    step(io, "analytics-token", "skip", `${error.message} Add it later with: npx furea analytics-token`);
    return;
  }
  step(io, "analytics-token", "create", "stored as the ANALYTICS_TOKEN secret");
}
