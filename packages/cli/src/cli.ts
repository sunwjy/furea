// Argument parsing and dispatch. Every effect (network, environment, terminal, config directory) is
// injected, so commands are tested end to end against recorded fixtures.

import { parseArgs } from "node:util";
import { login, logout } from "./commands/login.ts";
import type { CommandContext } from "./context.ts";
import { CredentialsFile } from "./credentials.ts";
import { CliError, type Io } from "./io.ts";
import { packageVersion } from "./package-files.ts";

export interface CliDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  configDir: string;
  io: Io;
}

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
  deploy (default)   Install or upgrade an instance
  login              Store a deploy token (--account-token opens the account-owned token form)
  logout             Remove a stored deploy token
  status, logs, domain, analytics-token, reset-password, access, destroy`;

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
    const ctx: CommandContext = {
      fetch: deps.fetch,
      env: deps.env,
      io,
      credentials: new CredentialsFile(deps.configDir),
      name: values.name,
      account: values.account,
    };
    switch (command) {
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
    if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
      io.err(`${error.message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
}
