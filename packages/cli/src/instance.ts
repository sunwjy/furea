// What the instance-management commands share: the verified deploy token and the instance's D1 database, found by
// name like everything else (ADR 0006: no local record of the instance).

import { CloudflareClient, type D1Database } from "./cloudflare/client.ts";
import type { CommandContext } from "./context.ts";
import { resolveDeployCredentials } from "./credentials.ts";
import { verifyDeployToken } from "./deploy-token.ts";
import { CliError } from "./io.ts";

export interface Connection {
  client: CloudflareClient;
  accountId: string;
}

/** The stored or environment deploy token, verified, and its account. Never starts the login flow. */
export async function connect(ctx: CommandContext): Promise<Connection> {
  const { token, accountId } = await resolveDeployCredentials(ctx);
  const client = new CloudflareClient({ token, fetch: ctx.fetch });
  await verifyDeployToken(client, token, accountId);
  return { client, accountId };
}

export function noInstance(ctx: CommandContext, accountId: string): CliError {
  return new CliError(`No furea instance named "${ctx.name}" in account ${accountId}; check --name, or install it with: npx furea deploy`);
}

/** The instance's D1 database; a missing one means there is no instance of that name. */
export async function instanceDatabase(ctx: CommandContext, { client, accountId }: Connection): Promise<D1Database> {
  const database = await client.findD1Database(accountId, ctx.name);
  if (!database) throw noInstance(ctx, accountId);
  return database;
}
