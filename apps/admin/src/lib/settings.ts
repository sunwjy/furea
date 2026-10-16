// The settings resource and the password change as seen by the admin surface (ADR 0009, *Settings*).

import { Settings, type ChangePasswordRequest, type UpdateSettingsRequest } from "@furea/shared";
import { queryOptions } from "@tanstack/react-query";
import { apiJson, apiSend } from "./api.ts";

export const settingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: () => apiJson("/settings", Settings),
});

export const updateSettings = (body: UpdateSettingsRequest) =>
  apiJson("/settings", Settings, { method: "PATCH", body });

/** Ends every session, this one included: the caller goes back to the login page. */
export const changePassword = (body: ChangePasswordRequest) => apiSend("/password", { method: "POST", body });
