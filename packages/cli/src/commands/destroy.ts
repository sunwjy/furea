// `furea destroy`: delete the instance (ADR 0006 *destroy*). Everything is found by name first and listed, then the
// operator types the name to confirm (`--confirm <name>` where nothing can be asked). Custom domain, Worker, KV
// namespace and D1 database go in that order, so the hostname stops answering before its data disappears;
// `--keep-database` keeps D1. The local deploy token is left alone. Nothing is rolled back: a failure part-way is
// finished by running the command again.

import type { CommandContext } from "../context.ts";
import { connect } from "../instance.ts";
import { CliError, type Io } from "../io.ts";

export interface DestroyOptions {
  keepDatabase: boolean;
  /** `--confirm <name>`: the typed confirmation, for when stdin is not a terminal. */
  confirm: string | undefined;
}

function line(io: Io, name: string, action: "delete" | "keep" | "skip", detail: string): void {
  io.out(`${name}  ${action}  ${detail}`);
}

export async function destroy(ctx: CommandContext, options: DestroyOptions): Promise<void> {
  const { io, name } = ctx;
  if (options.confirm !== undefined && options.confirm !== name) {
    throw new CliError(`--confirm "${options.confirm}" does not match the instance name "${name}"; nothing was deleted.`);
  }
  if (options.confirm === undefined && !io.interactive) {
    throw new CliError(`Confirm with --confirm ${name} (stdin is not a terminal, so the name cannot be typed).`);
  }

  const { client, accountId } = await connect(ctx);
  const domains = await client.listWorkerDomains(accountId, { service: name });
  const script = await client.getScriptBindings(accountId, name);
  const kv = await client.findKvNamespace(accountId, name);
  const database = await client.findD1Database(accountId, name);
  if (domains.length === 0 && !script && !kv && !database) {
    io.out(`Nothing named "${name}" in account ${accountId}; nothing to delete.`);
    return;
  }

  io.out(`This deletes the furea instance "${name}" in account ${accountId}:`);
  for (const domain of domains) io.out(`  custom domain  ${domain.hostname}`);
  if (script) io.out(`  Worker         ${name} (with its secrets and Cron Trigger)`);
  if (kv) io.out(`  KV namespace   ${name} (${kv.id})`);
  if (database) io.out(`  D1 database    ${name} (${database.uuid})${options.keepDatabase ? ", kept by --keep-database" : ": every link and setting"}`);
  if (options.confirm === undefined) {
    const typed = (await io.prompt(`Type the instance name ("${name}") to delete it: `)).trim();
    if (typed !== name) throw new CliError(`"${typed}" does not match "${name}"; nothing was deleted.`);
  }

  if (domains.length === 0) line(io, "domain", "skip", "none attached");
  for (const domain of domains) {
    await client.detachWorkerDomain(accountId, domain.id);
    line(io, "domain", "delete", domain.hostname);
  }
  if (script) {
    await client.deleteScript(accountId, name);
    line(io, "script", "delete", name);
  } else line(io, "script", "skip", "not found");
  if (kv) {
    await client.deleteKvNamespace(accountId, kv.id);
    line(io, "kv", "delete", `${name} (${kv.id})`);
  } else line(io, "kv", "skip", "not found");
  if (!database) line(io, "database", "skip", "not found");
  else if (options.keepDatabase) line(io, "database", "keep", `${name} (${database.uuid}), kept by --keep-database`);
  else {
    await client.deleteD1Database(accountId, database.uuid);
    line(io, "database", "delete", `${name} (${database.uuid})`);
  }
  io.out(`Destroyed "${name}". The deploy token stays stored; npx furea logout removes it.`);
}
