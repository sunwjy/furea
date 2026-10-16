// Argument parsing and dispatch. Every effect (network, environment, terminal, config directory) is
// injected, so commands are tested end to end against recorded fixtures.

import { parseArgs } from "node:util";
import { CloudflareApiError } from "./cloudflare/client.ts";
import { deploy } from "./commands/deploy.ts";
import { login, logout } from "./commands/login.ts";
import { status } from "./commands/status.ts";
import type { CommandContext } from "./context.ts";
import { CredentialsFile } from "./credentials.ts";
import { CliError, type Io } from "./io.ts";
import { type Installer, ownInstaller, packageVersion } from "./package-files.ts";

export interface CliDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  configDir: string;
  io: Io;
  /** The package `deploy` installs; this package unless a test substitutes a fixed one. */
  installer?: Installer;
  /** The npm registry lookup of the update check; `fetch` unless a test separates it from the Cloudflare API. */
  registryFetch?: typeof fetch;
}

// workers.dev rules (ADR 0006): at most 63 characters, alphanumerics and dashes, no leading or trailing dash.
const INSTANCE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

const COMMANDS = [
  "deploy",
  "status",
  "logs",
  "login",
  "logout",
  "domain",
  "analytics-token",
  "reset-password",
  "access",
  "destroy",
] as const;

const USAGE = `Usage: furea [command] [--name <instance>] [--account <account id>]

Commands:
  deploy (default)   Install or upgrade an instance (--workers-subdomain <name>, --allow-downgrade)
  status             Report the instance and any drift; exit 1 when something is wrong (--no-update-check)
  login              Store a deploy token (--account-token opens the account-owned token form)
  logout             Remove a stored deploy token
  logs, domain, analytics-token, reset-password, access, destroy`;

/** Runs one CLI invocation and returns its exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { io } = deps;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        name: { type: "string", default: "furea" },
        account: { type: "string" },
        "account-token": { type: "boolean", default: false },
        "workers-subdomain": { type: "string" },
        "allow-downgrade": { type: "boolean", default: false },
        "no-update-check": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
    if (values.version) {
      io.out(packageVersion());
      return 0;
    }
    const command = positionals[0] ?? "deploy";
    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    if (!(COMMANDS as readonly string[]).includes(command)) throw new CliError(`Unknown command "${command}".\n\n${USAGE}`);
    if (!INSTANCE_NAME.test(values.name)) {
      throw new CliError(`"${values.name}" is not a valid instance name: up to 63 letters, digits and dashes, not starting or ending with a dash.`);
    }
    const ctx: CommandContext = {
      fetch: deps.fetch,
      env: deps.env,
      io,
      credentials: new CredentialsFile(deps.configDir),
      name: values.name,
      account: values.account,
    };
    switch (command) {
      case "deploy":
        await deploy(ctx, {
          installer: deps.installer ?? ownInstaller(),
          workersSubdomain: values["workers-subdomain"],
          allowDowngrade: values["allow-downgrade"],
          registryFetch: deps.registryFetch ?? deps.fetch,
          noUpdateCheck: values["no-update-check"],
        });
        return 0;
      case "status":
        return await status(ctx, {
          installer: deps.installer ?? ownInstaller(),
          registryFetch: deps.registryFetch ?? deps.fetch,
          noUpdateCheck: values["no-update-check"],
        });
      case "login":
        await login(ctx, { accountToken: values["account-token"] });
        return 0;
      case "logout":
        await logout(ctx);
        return 0;
      default:
        throw new CliError(`furea ${packageVersion()}: "${command}" is not implemented yet.`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return 1;
    }
    if (error instanceof CloudflareApiError) {
      // Nothing is rolled back; re-running the command resumes where this one stopped (ADR 0006).
      io.err(`Cloudflare refused a request: ${error.message}\nFix the cause and run the command again; finished steps are reused.`);
      return 1;
    }
    if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
}
