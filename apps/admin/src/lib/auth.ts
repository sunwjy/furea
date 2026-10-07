// The operator's session as seen by the admin surface (ADR 0003, ADR 0009 authentication endpoints).

import { LoginMethodResponse, SessionResponse, type LoginRequest } from "@furea/shared";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, apiJson, apiSend } from "./api.ts";

/** The current caller, or null when not logged in. */
export const sessionQuery = queryOptions({
  queryKey: ["auth", "session"],
  queryFn: async (): Promise<SessionResponse | null> => {
    try {
      return await apiJson("/auth/session", SessionResponse);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
});

export const loginMethodQuery = queryOptions({
  queryKey: ["auth", "login-method"],
  queryFn: () => apiJson("/auth/login", LoginMethodResponse),
});

export const login = (body: LoginRequest) => apiSend("/auth/login", { method: "POST", body });

export const logout = () => apiSend("/auth/logout", { method: "POST" });
