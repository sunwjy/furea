// The API key resource as seen by the admin surface (ADR 0009, *Authentication endpoints*). Session only.

import { ApiKeyList, CreatedApiKey, type CreateApiKeyRequest } from "@furea/shared";
import { queryOptions } from "@tanstack/react-query";
import { apiJson, apiSend } from "./api.ts";

export const apiKeysQuery = queryOptions({
  queryKey: ["api-keys"],
  queryFn: () => apiJson("/api-keys", ApiKeyList),
});

export const createApiKey = (body: CreateApiKeyRequest) =>
  apiJson("/api-keys", CreatedApiKey, { method: "POST", body });

export const revokeApiKey = (id: string) => apiSend(`/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
