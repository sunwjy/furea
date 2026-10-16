// Argument parsing and dispatch. Every effect (network, environment, terminal, config directory) is
// injected, so commands are tested end to end against recorded fixtures.

import { parseArgs } from "node:util";
import { CloudflareApiError } from "./cloudflare/client.ts";
import { accessDisable, accessEnable } from "./commands/access.ts";
import { analyticsToken } from "./commands/analytics-token.ts";
import { destroy } from "./commands/destroy.ts";
import { deploy } from "./commands/deploy.ts";
import { domainSet, domainUnset } from "./commands/domain.ts";
import { login, logout } from "./commands/login.ts";
import { status } from "./commands/status.ts";
import { logs } from "./commands/logs.ts";
import { resetPassword } from "./commands/reset-password.ts";
import type { CommandContext } from "./context.ts";
import { CredentialsFile } from "./credentials.ts";
import { normalizeHostname } from "./hostname.ts";
import { CliError, type Io } from "./io.ts";
import { type Installer, ownInstaller, packageVersion } from "./package-files.ts";
import { type Clock, systemClock, type TailTransport, webSocketTransport } from "./tail-socket.ts";

export interface CliDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  configDir: string;
  io: Io;
  /** The package `deploy` installs; this package unless a test substitutes a fixed one. */
  installer?: Installer;
  /** The npm registry lookup of the update check; `fetch` unless a test separates it from the Cloudflare API. */
  registryFetch?: typeof fetch;
  /** Opens the tail's `trace-v1` WebSocket for `logs`; Node's WebSocket unless a test drives the sockets. */
  tail?: TailTransport;
  /** Renews the tail at `expires_at`; real timers unless a test fires them. */
  clock?: Clock;
  /** Called only by long-running commands: a signal aborted on Ctrl-C, so `logs` can delete its tail. */
  untilInterrupted?: () => AbortSignal;
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
  deploy (default)   Install or upgrade an instance (--hostname <hostname> | --workers-dev,
                     --workers-subdomain <name>, --allow-downgrade, --no-update-check)
  status             Report the instance and any drift; exit 1 when something is wrong (--no-update-check)
  login              Store a deploy token (--account-token opens the account-owned token form)
  logout             Remove a stored deploy token
  logs               Stream live events, without storing anything (--errors, --json)
  domain set <hostname>  Attach a Workers Custom Domain and turn workers.dev off
  domain unset       Detach the custom domain and answer on workers.dev (--workers-subdomain <name>)
  analytics-token    Store the read-only analytics token (FUREA_ANALYTICS_TOKEN; --account-token for the account-owned form)
  reset-password     Replace the operator password and sign out every session
  access enable      Turn Cloudflare Access mode on (--team-domain <team>.cloudflareaccess.com, --aud <tag>); own domain only
  access disable     Turn Cloudflare Access mode off
  destroy            Delete the instance (--confirm <name> without a terminal, --keep-database)`;

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
        hostname: { type: "string" },
        "workers-dev": { type: "boolean", default: false },
        "workers-subdomain": { type: "string" },
        "allow-downgrade": { type: "boolean", default: false },
        "no-update-check": { type: "boolean", default: false },
        errors: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "team-domain": { type: "string" },
        aud: { type: "string" },
        "keep-database": { type: "boolean", default: false },
        confirm: { type: "string" },
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
    if (values.hostname !== undefined && values["workers-dev"]) throw new CliError("Pass either --hostname or --workers-dev, not both.");
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
          hostname: {
            hostname: values.hostname === undefined ? undefined : normalizeHostname(values.hostname),
            workersDev: values["workers-dev"],
            workersSubdomain: values["workers-subdomain"],
          },
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
      case "logs":
        await logs(ctx, {
          errors: values.errors,
          json: values.json,
          transport: deps.tail ?? webSocketTransport,
          clock: deps.clock ?? systemClock,
          stop: deps.untilInterrupted?.() ?? new AbortController().signal,
        });
        return 0;
      case "logout":
        await logout(ctx);
        return 0;
      case "domain": {
        const [, action, hostname, ...rest] = positionals;
        if (action === "set" && hostname !== undefined && rest.length === 0) await domainSet(ctx, normalizeHostname(hostname));
        else if (action === "unset" && hostname === undefined) await domainUnset(ctx, values["workers-subdomain"]);
        else throw new CliError(`Usage: furea domain set <hostname> | furea domain unset`);
        return 0;
      }
      case "analytics-token":
        await analyticsToken(ctx, { accountToken: values["account-token"] });
        return 0;
      case "access": {
        const action = positionals[1];
        if (action === "enable") await accessEnable(ctx, { teamDomain: values["team-domain"], aud: values.aud });
        else if (action === "disable") await accessDisable(ctx);
        else throw new CliError(`Use: furea access enable [--team-domain <team>.cloudflareaccess.com] [--aud <tag>], or furea access disable.`);
        return 0;
      }
      case "destroy":
        await destroy(ctx, { keepDatabase: values["keep-database"], confirm: values.confirm });
        return 0;
      case "reset-password":
        await resetPassword(ctx);
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
