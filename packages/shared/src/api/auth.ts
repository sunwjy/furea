// Authentication endpoints of the public API (ADR 0009, *Authentication endpoints*; ADR 0003).

import { z } from "zod";

/** `POST /auth/login`. The length cap matches the password policy's maximum (ADR 0003). */
export const LoginRequest = z.strictObject({
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** `GET /auth/login`: which door is open. */
export const LoginMethodResponse = z.object({
  method: z.enum(["password", "access"]),
});
export type LoginMethodResponse = z.infer<typeof LoginMethodResponse>;

export const Scope = z.enum(["read", "write"]);
export type Scope = z.infer<typeof Scope>;

/** `GET /auth/session`: who the caller is. */
export const SessionResponse = z.object({
  kind: z.enum(["session", "access", "apiKey"]),
  scope: Scope,
  apiKey: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;
