// The settings resource and the password change of the public API (ADR 0009, *Settings*; ADR 0008 root
// destination; ADR 0003 password policy).

import { z } from "zod";
import { Destination } from "./links.ts";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Present in a `PATCH` body at all, with any value, it is refused: the instance reports it, the operator cannot set it. */
const ReadOnly = (what: string) =>
  z
    .unknown()
    .refine(() => false, { message: `${what} is read-only.`, params: { code: "read_only_field" } })
    .describe(`Never accepted: ${what} is read-only (read_only_field).`);

/** A team's own label under Cloudflare's Access domain: the only host the Worker fetches public keys from. */
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_MAX_LENGTH = 256;

/** Lowercased, with an `https://` in front or a `/` behind tolerated, since that is how the dashboard shows it. */
export const AccessTeamDomain = z
  .string()
  .transform((value) => value.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, ""))
  .refine((value) => TEAM_DOMAIN.test(value), {
    message: "Use the team domain, like myteam.cloudflareaccess.com.",
    params: { code: "access_team_domain_invalid" },
  })
  .describe("The Zero Trust team domain, `<team>.cloudflareaccess.com`.");

export const AccessAud = z
  .string()
  .trim()
  .refine((value) => value.length > 0 && value.length <= AUD_MAX_LENGTH && !/\s/.test(value), {
    message: "Use the Application Audience (AUD) tag of the Access application.",
    params: { code: "access_aud_invalid" },
  })
  .describe("The Application Audience (AUD) tag of the Access application that guards /admin and /api.");

export const AccessSettingsRequest = z.strictObject({ teamDomain: AccessTeamDomain, aud: AccessAud });

/** `PATCH /settings`, a merge-patch: only the fields present change. */
export const UpdateSettingsRequest = z.strictObject({
  rootDestination: Destination.nullable()
    .optional()
    .describe("Where the bare hostname redirects (302, not a click); null unsets it and / answers 404."),
  access: AccessSettingsRequest.nullable()
    .optional()
    .describe(
      "Turns Cloudflare Access mode on (session only, own domain only, the team's public keys must be reachable); " +
        "null turns it off.",
    ),
  analyticsConfigured: ReadOnly("analyticsConfigured").optional(),
  version: ReadOnly("version").optional(),
});
export type UpdateSettingsRequest = Omit<z.input<typeof UpdateSettingsRequest>, "analyticsConfigured" | "version">;
export type UpdateSettingsBody = Omit<z.output<typeof UpdateSettingsRequest>, "analyticsConfigured" | "version">;

export const AccessSettings = z.object({ teamDomain: z.string(), aud: z.string() });
export type AccessSettings = z.infer<typeof AccessSettings>;

/** `GET /settings` and the answer to `PATCH /settings`. */
export const Settings = z.object({
  rootDestination: z.string().nullable(),
  /** Cloudflare Access mode; `null` while it is off. */
  access: AccessSettings.nullable(),
  /** Whether the analytics token is placed (by the installer); read-only. */
  analyticsConfigured: z.boolean(),
  /** The deployed furea version; read-only. */
  version: z.string(),
});
export type Settings = z.infer<typeof Settings>;

/** `POST /password`. Re-authenticates with the current password; 12 to 256 characters, no complexity rules. */
export const ChangePasswordRequest = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { message: `Use at least ${PASSWORD_MIN_LENGTH} characters.` })
    .max(PASSWORD_MAX_LENGTH, { message: `Use at most ${PASSWORD_MAX_LENGTH} characters.` })
    .describe(`${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters, no complexity rules.`),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
