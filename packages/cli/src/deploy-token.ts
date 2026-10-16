// The deploy token (ADR 0006 *Deploy token*): template URLs, account resolution and verification.

import { type Account, CloudflareApiError, CloudflareClient } from "./cloudflare/client.ts";
import { CliError, choose, type Io } from "./io.ts";

export type TokenKind = "user" | "account";

// Short permission keys of the dashboard's template URLs, as listed on
// https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/ (checked 2026-10-16;
// `dns` is the DNS key, `zone_dns` and `workers_kv` were wrong keys once printed there, cloudflare-docs#29825).
const DEPLOY_PERMISSIONS = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_kv_storage", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "zone", type: "read" },
  { key: "dns", type: "edit" },
];

/** The separate read-only credential of ADR 0005, never folded into the deploy token. */
const ANALYTICS_PERMISSIONS = [{ key: "account_analytics", type: "read" }];

function templateUrl(kind: TokenKind, permissions: object[], name: string): string {
  const keys = encodeURIComponent(JSON.stringify(permissions));
  return kind === "account"
    ? `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${keys}&name=${name}`
    : `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${keys}&accountId=*&zoneId=all&name=${name}`;
}

/** The dashboard form pre-filled with the deploy permissions; the user-token form unless asked otherwise. */
export function deployTokenTemplateUrl(kind: TokenKind): string {
  return templateUrl(kind, DEPLOY_PERMISSIONS, "furea");
}

/** The dashboard form pre-filled with Account Analytics Read, for the `ANALYTICS_TOKEN` secret. */
export function analyticsTokenTemplateUrl(kind: TokenKind): string {
  return templateUrl(kind, ANALYTICS_PERMISSIONS, "furea-analytics");
}

/** `--account` / `CLOUDFLARE_ACCOUNT_ID` when given, else the one account `GET /accounts` returns (or a choice). */
export async function resolveAccount(client: CloudflareClient, io: Io, given: string | undefined): Promise<string> {
  if (given) return given;
  let accounts: Account[];
  try {
    accounts = await client.listAccounts();
  } catch (error) {
    if (error instanceof CloudflareApiError && (error.status === 401 || error.status === 403)) {
      throw new CliError(`Cloudflare rejected the token: ${error.message}`);
    }
    throw error;
  }
  if (accounts.length === 0) throw new CliError("The token cannot see any Cloudflare account; pass --account.");
  if (accounts.length === 1) return accounts[0]!.id;
  const account = await choose(io, "The token can see several accounts", accounts, (a) => `${a.name} (${a.id})`, "--account");
  return account.id;
}

/**
 * Verifies on the endpoint the prefix suggests (`cfat_` is account-owned), retrying once on the other
 * endpoint after a `401`, because the prefix is a convention, not a contract. Never calls `/user` or `/memberships`.
 */
export async function verifyDeployToken(client: CloudflareClient, token: string, accountId: string): Promise<void> {
  const byAccount = () => client.verifyAccountToken(accountId);
  const byUser = () => client.verifyUserToken();
  const [first, second] = token.startsWith("cfat_") ? [byAccount, byUser] : [byUser, byAccount];
  let status: string;
  try {
    status = (await first()).status;
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 401)) throw rejected(error);
    try {
      status = (await second()).status;
    } catch (retryError) {
      throw rejected(retryError);
    }
  }
  if (status !== "active") throw new CliError(`The deploy token is ${status}, not active.`);
}

function rejected(error: unknown): unknown {
  return error instanceof CloudflareApiError ? new CliError(`Cloudflare rejected the token: ${error.message}`) : error;
}
