// The settings resource and the password change of the public API (ADR 0009, *Settings*; ADR 0008 root
// destination; ADR 0003 password policy).

import { z } from "zod";
import { Destination, ScreeningOverride } from "./links.ts";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** Present in a `PATCH` body at all, with any value, it is refused: the instance reports it, the operator cannot set it. */
const ReadOnly = (what: string) =>
  z
    .unknown()
    .refine(() => false, { message: `${what} is read-only.`, params: { code: "read_only_field" } })
    .describe(`Never accepted: ${what} is read-only (read_only_field).`);

/** `PATCH /settings`, a merge-patch: only the fields present change. */
export const UpdateSettingsRequest = z.strictObject({
  rootDestination: Destination.nullable()
    .optional()
    .describe("Where the bare hostname redirects (302, not a click); null unsets it and / answers 404."),
  analyticsConfigured: ReadOnly("analyticsConfigured").optional(),
  version: ReadOnly("version").optional(),
  screening: ScreeningOverride,
});
export type UpdateSettingsRequest = Omit<z.input<typeof UpdateSettingsRequest>, "analyticsConfigured" | "version">;
export type UpdateSettingsBody = Omit<z.output<typeof UpdateSettingsRequest>, "analyticsConfigured" | "version">;

export const AccessSettings = z.object({ teamDomain: z.string(), aud: z.string() });

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
