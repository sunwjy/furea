// Where an instance answers (ADR 0006 step 8): a Workers Custom Domain on the operator's own zone, or
// `<name>.<subdomain>.workers.dev`. Custom-domain problems stop with their cause; nothing is ever overridden.

import { CloudflareApiError, type CloudflareClient, type ScriptSubdomain, type WorkerDomain, type Zone } from "./cloudflare/client.ts";
import type { CommandContext } from "./context.ts";
import { ask, CliError, step } from "./io.ts";

/** A custom-domain problem: zone missing or inactive, hostname held by another Worker or a DNS record. */
export class DomainConflict extends CliError {
  override name = "DomainConflict";
}

// At least two labels; each label 1-63 letters, digits and dashes, not starting or ending with a dash.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHostname(input: string): string {
  const hostname = input.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME.test(hostname)) throw new CliError(`"${input}" is not a hostname (for example go.example.com).`);
  return hostname;
}

/** The account's zone for the hostname, found by trimming labels from the left (`a.b.example.com`, `b.example.com`, `example.com`). */
async function zoneFor(client: CloudflareClient, accountId: string, hostname: string): Promise<Zone> {
  const labels = hostname.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = await client.findZone(accountId, labels.slice(i).join("."));
    if (!zone) continue;
    if (zone.status !== "active") {
      throw new DomainConflict(`The zone ${zone.name} is ${zone.status}, not active yet; a Custom Domain needs an active zone.`);
    }
    return zone;
  }
  throw new DomainConflict(
    `No zone for ${hostname} in this account: add its domain to Cloudflare (or give the deploy token Zone Read on it).`,
  );
}

/** Attaches `hostname` to the instance's Worker, refusing anything that would take it from someone else. */
export async function attachDomain(client: CloudflareClient, accountId: string, name: string, hostname: string): Promise<WorkerDomain> {
  const holder = (await client.listWorkerDomains(accountId, { hostname })).find((d) => d.hostname === hostname);
  if (holder && holder.service !== name) {
    throw new DomainConflict(`${hostname} is already attached to the Worker "${holder.service}"; detach it there or choose another hostname.`);
  }
  if (holder) return holder;
  const zone = await zoneFor(client, accountId, hostname);
  try {
    return await client.attachWorkerDomain(accountId, { hostname, service: name, zone_id: zone.id });
  } catch (error) {
    if (!(error instanceof CloudflareApiError)) throw error;
    const cause = error.errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${error.status}`;
    throw new DomainConflict(`Cloudflare refused to attach ${hostname}: ${cause}`);
  }
}

/** Turns the workers.dev route on, registering the account subdomain first when there is none; returns the URL. */
export async function enableWorkersDev(
  ctx: CommandContext,
  client: CloudflareClient,
  accountId: string,
  wanted: string | undefined,
  current?: ScriptSubdomain,
): Promise<string> {
  const state = current ?? (await client.getScriptSubdomain(accountId, ctx.name));
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
  if (!state.enabled) {
    await client.setScriptSubdomain(accountId, ctx.name, { enabled: true, previews_enabled: false });
    created = true;
  }
  const url = `https://${ctx.name}.${subdomain}.workers.dev`;
  step(ctx.io, "workers.dev", created ? "create" : "reuse", url);
  return url;
}

/** Once a Custom Domain is attached the workers.dev route is turned off, so the instance has one public origin. */
export async function disableWorkersDev(
  ctx: CommandContext,
  client: CloudflareClient,
  accountId: string,
  hostname: string,
  current?: ScriptSubdomain,
): Promise<void> {
  const state = current ?? (await client.getScriptSubdomain(accountId, ctx.name));
  if (state.enabled) await client.setScriptSubdomain(accountId, ctx.name, { enabled: false, previews_enabled: false });
  step(ctx.io, "workers.dev", "skip", `disabled; the instance answers on ${hostname}`);
}

export interface HostnameChoice {
  /** `--hostname`, normalised. */
  hostname: string | undefined;
  /** `--workers-dev`. */
  workersDev: boolean;
  /** `--workers-subdomain`. */
  workersSubdomain: string | undefined;
}

export const HOSTNAME_CHOICE_FLAGS = "--hostname <hostname> or --workers-dev";

/**
 * `deploy` step 8: reuse whatever is attached; when nothing is (a first install, or one interrupted before
 * this step), take the operator's choice. Returns the instance's public origin.
 */
export async function resolveHostname(
  ctx: CommandContext,
  client: CloudflareClient,
  accountId: string,
  choice: HostnameChoice,
  scriptExisted: boolean,
): Promise<string> {
  const { io, name } = ctx;
  const [domain] = await client.listWorkerDomains(accountId, { service: name });
  const workersDev = await client.getScriptSubdomain(accountId, name);

  if (domain) {
    if (choice.workersDev) throw new CliError(`"${name}" answers on ${domain.hostname}; to move it to workers.dev run npx furea domain unset.`);
    if (choice.hostname && choice.hostname !== domain.hostname) {
      throw new CliError(`"${name}" answers on ${domain.hostname}; to move it run npx furea domain set ${choice.hostname}.`);
    }
    step(io, "domain", "reuse", `https://${domain.hostname}`);
    await disableWorkersDev(ctx, client, accountId, domain.hostname, workersDev);
    return `https://${domain.hostname}`;
  }
  if (scriptExisted && workersDev.enabled) {
    if (choice.hostname) {
      throw new CliError(`"${name}" answers on workers.dev; to move it run npx furea domain set ${choice.hostname}.`);
    }
    return enableWorkersDev(ctx, client, accountId, choice.workersSubdomain, workersDev);
  }

  const hostname = choice.hostname ?? (choice.workersDev ? undefined : await askHostname(ctx));
  if (hostname === undefined) return enableWorkersDev(ctx, client, accountId, choice.workersSubdomain, workersDev);
  try {
    await attachDomain(client, accountId, name, hostname);
  } catch (error) {
    if (!(error instanceof DomainConflict) || !io.interactive) throw error;
    // Offered once, interactively only; the public hostname of a shortener never changes silently (ADR 0006).
    io.err(error.message);
    const answer = (await io.prompt(`Open the instance on workers.dev for now? Fix the cause, then run npx furea domain set ${hostname}. [y/N] `))
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new CliError("Stopped; nothing was overridden. Fix the cause and run npx furea deploy again.");
    return enableWorkersDev(ctx, client, accountId, choice.workersSubdomain, workersDev);
  }
  step(io, "domain", "create", `https://${hostname}`);
  await disableWorkersDev(ctx, client, accountId, hostname, workersDev);
  return `https://${hostname}`;
}

async function askHostname(ctx: CommandContext): Promise<string | undefined> {
  if (!ctx.io.interactive) {
    throw new CliError(`Choose where the instance answers: pass ${HOSTNAME_CHOICE_FLAGS} (stdin is not a terminal, so nothing is prompted).`);
  }
  const answer = (await ctx.io.prompt("Hostname on your own domain (e.g. go.example.com), or press Enter for workers.dev: ")).trim();
  return answer === "" ? undefined : normalizeHostname(answer);
}
