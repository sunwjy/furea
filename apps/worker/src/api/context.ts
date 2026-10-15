import type { Scope } from "@furea/shared";
import type { Env } from "../core/env.ts";

/** Who is calling (ADR 0009, *Who may call what*). Access mode adds its own kind later. */
export interface SessionCaller {
  kind: "session";
  scope: Scope;
  /** SHA-256 of the cookie's session id, the `sessions` row key. */
  sessionIdHash: string;
}

export interface ApiKeyCaller {
  kind: "apiKey";
  scope: Scope;
  apiKey: { id: string; name: string };
}

export type Caller = SessionCaller | ApiKeyCaller;

export interface ApiEnv {
  Bindings: Env;
  Variables: { caller: Caller | null };
}
