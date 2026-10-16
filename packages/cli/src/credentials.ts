// The CLI's only local state (ADR 0006): one file, mode 0600, mapping account id to deploy token.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CloudflareClient } from "./cloudflare/client.ts";
import type { CommandContext } from "./context.ts";
import { resolveAccount } from "./deploy-token.ts";
import { choose, CliError } from "./io.ts";

export type Credentials = Record<string, string>;

export interface DeployCredentials {
  token: string;
  accountId: string;
}

/**
 * The token and account a command runs with. `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID` or `--account`)
 * bypasses the file entirely; otherwise `--account` picks a stored entry and a single entry is picked automatically.
 */
export async function resolveDeployCredentials(ctx: CommandContext): Promise<DeployCredentials> {
  const envToken = ctx.env.CLOUDFLARE_API_TOKEN;
  if (envToken) {
    const client = new CloudflareClient({ token: envToken, fetch: ctx.fetch });
    const accountId = await resolveAccount(client, ctx.io, ctx.account ?? ctx.env.CLOUDFLARE_ACCOUNT_ID);
    return { token: envToken, accountId };
  }
  const stored = ctx.credentials.read();
  const ids = Object.keys(stored);
  if (ctx.account) {
    const token = stored[ctx.account];
    if (!token) throw new CliError(`No deploy token is stored for account ${ctx.account}; run: furea login --account ${ctx.account}`);
    return { token, accountId: ctx.account };
  }
  if (ids.length === 0) throw new CliError("No deploy token: run furea login, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  const accountId = ids.length === 1 ? ids[0]! : await choose(ctx.io, "Tokens are stored for several accounts", ids, (id) => id, "--account");
  return { token: stored[accountId]!, accountId };
}

export function defaultConfigDir(env: Record<string, string | undefined>): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "furea");
}

export class CredentialsFile {
  readonly path: string;

  constructor(readonly dir: string) {
    this.path = join(dir, "credentials.json");
  }

  read(): Credentials {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(text) as { accounts?: Credentials };
    return parsed.accounts ?? {};
  }

  write(accounts: Credentials): void {
    if (Object.keys(accounts).length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
    // `mode` only applies when the file is created; tighten an existing one too.
    chmodSync(this.path, 0o600);
  }

  set(accountId: string, token: string): void {
    this.write({ ...this.read(), [accountId]: token });
  }

  remove(accountId: string): boolean {
    const accounts = this.read();
    if (!(accountId in accounts)) return false;
    delete accounts[accountId];
    this.write(accounts);
    return true;
  }
}
