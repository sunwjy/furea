// `furea login` / `furea logout`: add or remove a deploy token in the credentials file (ADR 0006).

import { CloudflareClient } from "../cloudflare/client.ts";
import type { CommandContext } from "../context.ts";
import { deployTokenTemplateUrl, resolveAccount, verifyDeployToken } from "../deploy-token.ts";
import { ask, choose, CliError } from "../io.ts";

export async function login(ctx: CommandContext, options: { accountToken: boolean }): Promise<void> {
  const { io, env } = ctx;
  let token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    if (!io.interactive) {
      throw new CliError("Missing deploy token: set CLOUDFLARE_API_TOKEN (stdin is not a terminal, so nothing is prompted).");
    }
    const url = deployTokenTemplateUrl(options.accountToken ? "account" : "user");
    io.out("Create a deploy token with the pre-filled form (opening it in your browser):");
    io.out(`  ${url}`);
    await io.openUrl(url);
    token = await ask(io, "Paste the deploy token: ", "CLOUDFLARE_API_TOKEN", { secret: true });
  }
  const client = new CloudflareClient({ token, fetch: ctx.fetch });
  const accountId = await resolveAccount(client, io, ctx.account ?? env.CLOUDFLARE_ACCOUNT_ID);
  await verifyDeployToken(client, token, accountId);
  ctx.credentials.set(accountId, token);
  io.out(`Logged in: the deploy token for account ${accountId} is stored in ${ctx.credentials.path}.`);
}

export async function logout(ctx: CommandContext): Promise<void> {
  const { io } = ctx;
  const stored = Object.keys(ctx.credentials.read());
  let accountId = ctx.account;
  if (!accountId) {
    if (stored.length === 0) {
      io.out("No deploy token is stored.");
      return;
    }
    accountId = stored.length === 1 ? stored[0]! : await choose(io, "Tokens are stored for several accounts", stored, (id) => id, "--account");
  }
  if (!ctx.credentials.remove(accountId)) throw new CliError(`No deploy token is stored for account ${accountId}.`);
  io.out(`Logged out: removed the deploy token for account ${accountId}.`);
}
