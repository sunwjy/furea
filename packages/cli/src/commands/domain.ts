// `furea domain set <hostname>` / `furea domain unset`: attach or detach a Workers Custom Domain after
// install. The Worker derives its origin from the request (ADR 0006), so the script is never re-uploaded.

import { CloudflareClient } from "../cloudflare/client.ts";
import type { CommandContext } from "../context.ts";
import { resolveDeployCredentials } from "../credentials.ts";
import { attachDomain, disableWorkersDev, enableWorkersDev } from "../hostname.ts";
import { CliError, step } from "../io.ts";

async function instance(ctx: CommandContext) {
  const { token, accountId } = await resolveDeployCredentials(ctx);
  const client = new CloudflareClient({ token, fetch: ctx.fetch });
  if ((await client.getScriptBindings(accountId, ctx.name)) === undefined) {
    throw new CliError(`No instance named "${ctx.name}" in this account; run npx furea deploy first.`);
  }
  return { client, accountId };
}

/** Attaches `hostname`, then detaches any previous hostname of the instance and turns workers.dev off. */
export async function domainSet(ctx: CommandContext, hostname: string): Promise<void> {
  const { io, name } = ctx;
  const { client, accountId } = await instance(ctx);
  const attached = await client.listWorkerDomains(accountId, { service: name });
  const previous = attached.filter((d) => d.hostname !== hostname);
  const reused = previous.length < attached.length;
  if (!reused) await attachDomain(client, accountId, name, hostname);
  // Only after the new hostname answers, so the instance is never left without one.
  for (const domain of previous) await client.detachWorkerDomain(accountId, domain.id);
  const replaces = previous.length > 0 ? ` (replaces ${previous.map((d) => d.hostname).join(", ")})` : "";
  step(io, "domain", reused ? "reuse" : "create", `https://${hostname}${replaces}`);
  await disableWorkersDev(ctx, client, accountId, hostname);
  io.out(`Ready: https://${hostname}/admin/`);
}

/** Puts the instance back on workers.dev first, then detaches every custom domain it has. */
export async function domainUnset(ctx: CommandContext, workersSubdomain: string | undefined): Promise<void> {
  const { io, name } = ctx;
  const { client, accountId } = await instance(ctx);
  const attached = await client.listWorkerDomains(accountId, { service: name });
  const url = await enableWorkersDev(ctx, client, accountId, workersSubdomain);
  if (attached.length === 0) step(io, "domain", "skip", "no custom domain attached");
  for (const domain of attached) {
    await client.detachWorkerDomain(accountId, domain.id);
    step(io, "domain", "skip", `detached ${domain.hostname}`);
  }
  io.out(`Ready: ${url}/admin/`);
}
