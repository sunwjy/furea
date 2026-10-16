// `furea access enable|disable`: Cloudflare Access mode from the CLI (ADR 0003). The settings are written straight
// into D1 with the same rows and the same checks the Worker's `PATCH /settings` uses: enabling needs an own domain
// (an Access application on workers.dev would gate the slugs too) and the team's reachable public keys, and it signs
// out every password session.

import { accessCertsUrl, isAccessAud, isTeamDomain, normalizeTeamDomain } from "@furea/shared/access";
import type { CommandContext } from "../context.ts";
import { connect, instanceDatabase } from "../instance.ts";
import { ask, CliError } from "../io.ts";

export interface AccessEnableOptions {
  /** `--team-domain` */
  teamDomain: string | undefined;
  /** `--aud` */
  aud: string | undefined;
}

export async function accessEnable(ctx: CommandContext, options: AccessEnableOptions): Promise<void> {
  const { io } = ctx;
  if (!io.interactive && (options.teamDomain === undefined || options.aud === undefined)) {
    throw new CliError("Missing value: pass --team-domain and --aud (stdin is not a terminal, so nothing is prompted).");
  }
  // Flag values are checked before anything is called.
  if (options.teamDomain !== undefined) teamDomainOf(options.teamDomain);
  if (options.aud !== undefined) audOf(options.aud);

  const connection = await connect(ctx);
  const { client, accountId } = connection;
  const database = await instanceDatabase(ctx, connection);
  const [domain] = await client.listWorkerDomains(accountId, { service: ctx.name });
  if (!domain) {
    throw new CliError(
      `"${ctx.name}" is only on workers.dev. Access mode needs the instance on its own domain, because an Access ` +
        "application cannot be limited to /admin there and would gate every short link too. " +
        "Attach one first: npx furea domain set <hostname>",
    );
  }

  const teamDomain = teamDomainOf(
    options.teamDomain ?? (await ask(io, "Zero Trust team domain (<team>.cloudflareaccess.com): ", "--team-domain")),
  );
  const aud = audOf(options.aud ?? (await ask(io, "Application Audience (AUD) tag of the Access application: ", "--aud")));
  if (!(await keysReachable(ctx.fetch, teamDomain))) {
    throw new CliError(`Could not fetch the public keys of ${teamDomain} (${accessCertsUrl(teamDomain)}); check the team domain.`);
  }

  await client.d1Query(
    accountId,
    database.uuid,
    "INSERT INTO settings (key, value) VALUES ('access_team_domain', ?), ('access_aud', ?) " +
      "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [teamDomain, aud],
  );
  // After the settings, so a password login in between cannot leave a session behind that comes back if Access
  // mode is turned off later. A failure here is repaired by running the command again.
  await client.d1Query(accountId, database.uuid, "DELETE FROM sessions");
  io.out(`Access mode is on for https://${domain.hostname}: sign-in goes through ${teamDomain}; password sessions are signed out.`);
  io.out("API keys keep working. Turn it off with: npx furea access disable");
}

export async function accessDisable(ctx: CommandContext): Promise<void> {
  const connection = await connect(ctx);
  const database = await instanceDatabase(ctx, connection);
  const [deleted] = await connection.client.d1Query(
    connection.accountId,
    database.uuid,
    "DELETE FROM settings WHERE key IN ('access_team_domain', 'access_aud')",
  );
  const wasOn = (deleted?.meta?.changes ?? 0) > 0;
  ctx.io.out(
    wasOn
      ? "Access mode is off: the operator password signs in again."
      : "Access mode is off (it was not on); the operator password signs in.",
  );
}

function teamDomainOf(value: string): string {
  const teamDomain = normalizeTeamDomain(value);
  if (!isTeamDomain(teamDomain)) throw new CliError(`"${value}" is not a team domain; use one like myteam.cloudflareaccess.com.`);
  return teamDomain;
}

function audOf(value: string): string {
  const aud = value.trim();
  if (!isAccessAud(aud)) throw new CliError("Use the Application Audience (AUD) tag of the Access application (no spaces).");
  return aud;
}

/** The same test the Worker makes before turning Access mode on: the certs endpoint answers with at least one key. */
async function keysReachable(fetcher: typeof fetch, teamDomain: string): Promise<boolean> {
  try {
    const response = await fetcher(accessCertsUrl(teamDomain));
    if (!response.ok) return false;
    const body = (await response.json()) as { keys?: unknown };
    return Array.isArray(body.keys) && body.keys.length > 0;
  } catch {
    return false;
  }
}
