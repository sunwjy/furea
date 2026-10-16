// `furea analytics-token`: create or replace the read-only analytics token stored as the `ANALYTICS_TOKEN` Worker
// secret (ADR 0005, ADR 0006). The token is verified before it is stored; the deploy token never doubles as it.

import { CloudflareClient } from "../cloudflare/client.ts";
import type { CommandContext } from "../context.ts";
import { analyticsTokenTemplateUrl, type TokenKind, verifyToken } from "../deploy-token.ts";
import { connect, noInstance } from "../instance.ts";
import { ask, CliError } from "../io.ts";
import { ANALYTICS_ENGINE_DOCS } from "../links.ts";

const SECRET = "ANALYTICS_TOKEN";

export async function analyticsToken(ctx: CommandContext, options: { accountToken: boolean }): Promise<void> {
  const { io } = ctx;
  if (!ctx.env.FUREA_ANALYTICS_TOKEN && !io.interactive) {
    throw new CliError("Missing analytics token: set FUREA_ANALYTICS_TOKEN (stdin is not a terminal, so nothing is prompted).");
  }
  const { client, accountId } = await connect(ctx);
  const bindings = await client.getScriptBindings(accountId, ctx.name);
  if (!bindings) throw noInstance(ctx, accountId);

  const token = ctx.env.FUREA_ANALYTICS_TOKEN || (await pasteAnalyticsToken(ctx, options.accountToken ? "account" : "user"));
  await storeAnalyticsToken(ctx, client, accountId, token);
  const replaced = bindings.some((b) => b.type === "secret_text" && b.name === SECRET);
  io.out(`Stored the analytics token as the ${SECRET} secret${replaced ? ", replacing the previous one" : ""}.`);
  if (!bindings.some((b) => b.type === "analytics_engine")) {
    io.out(
      "Warning: the instance has no CLICKS binding (Analytics Engine is not enabled on this account), so click " +
        `breakdowns stay empty until it is added: ${ANALYTICS_ENGINE_DOCS}`,
    );
  }
}

/** Opens the pre-filled read-only template and asks for the token it creates. */
export async function pasteAnalyticsToken(ctx: CommandContext, kind: TokenKind): Promise<string> {
  const url = analyticsTokenTemplateUrl(kind);
  ctx.io.out("Create a read-only analytics token with the pre-filled form (opening it in your browser):");
  ctx.io.out(`  ${url}`);
  await ctx.io.openUrl(url);
  return ask(ctx.io, "Paste the analytics token: ", "FUREA_ANALYTICS_TOKEN", { secret: true });
}

/** Verifies the token (as itself, not with the deploy token) and stores it; `deployClient` carries the deploy token. */
export async function storeAnalyticsToken(ctx: CommandContext, deployClient: CloudflareClient, accountId: string, token: string): Promise<void> {
  await verifyToken(new CloudflareClient({ token, fetch: ctx.fetch }), token, accountId, "analytics");
  await deployClient.putSecret(accountId, ctx.name, SECRET, token);
}
