// Cloudflare Access mode's two settings (ADR 0003), without zod: the API schema and the CLI's `access enable` agree
// on what a team domain and an AUD tag are.

/** A team's own label under Cloudflare's Access domain: the only host the Worker fetches public keys from. */
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
export const ACCESS_AUD_MAX_LENGTH = 256;

/** Lowercased, with an `https://` in front or a `/` behind tolerated, since that is how the dashboard shows it. */
export function normalizeTeamDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "");
}

/** Whether a normalized value is `<team>.cloudflareaccess.com`. */
export function isTeamDomain(value: string): boolean {
  return TEAM_DOMAIN.test(value);
}

/** Whether a trimmed value can be an Application Audience (AUD) tag. */
export function isAccessAud(value: string): boolean {
  return value.length > 0 && value.length <= ACCESS_AUD_MAX_LENGTH && !/\s/.test(value);
}

/** Where a team publishes the keys its Access JWTs are signed with. */
export const accessCertsUrl = (teamDomain: string) => `https://${teamDomain}/cdn-cgi/access/certs`;
