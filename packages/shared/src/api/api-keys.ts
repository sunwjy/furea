// The API key resource (ADR 0009, *Authentication endpoints*; ADR 0003, *API keys*).

import { z } from "zod";
import { Scope } from "./auth.ts";

export const API_KEY_NAME_MAX_LENGTH = 64;

/** Trimmed, 1 to 64 characters. */
export const ApiKeyName = z
  .string()
  .trim()
  .refine((name) => name.length >= 1 && name.length <= API_KEY_NAME_MAX_LENGTH, {
    message: `Use 1 to ${API_KEY_NAME_MAX_LENGTH} characters.`,
  })
  .describe(`What the key is for, trimmed, 1 to ${API_KEY_NAME_MAX_LENGTH} characters.`);

/** `POST /api-keys`. */
export const CreateApiKeyRequest = z.strictObject({
  name: ApiKeyName,
  scope: Scope.describe("read lists and reads; write also creates, edits and deletes links."),
});
export type CreateApiKeyRequest = z.input<typeof CreateApiKeyRequest>;

/** A key as listed: never the key itself, only the first 8 characters after `furea_` for recognition. */
export const ApiKey = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string().describe("The first 8 characters after furea_, for recognition only; may collide."),
  scope: Scope,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable().describe("Updated at most once per day."),
});
export type ApiKey = z.infer<typeof ApiKey>;

/** `GET /api-keys`: every key, unpaginated. */
export const ApiKeyList = z.array(ApiKey);

/** `POST /api-keys` answer: the only response that ever carries the key itself. */
export const CreatedApiKey = ApiKey.extend({
  key: z.string().describe("The API key, furea_ followed by 45 characters. Shown this once."),
});
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;
