import type { Scope } from "@furea/shared";
import type { Env } from "../core/env.ts";

/** Who is calling (ADR 0009, *Who may call what*). API keys and Access mode add their own kinds later. */
export interface SessionCaller {
  kind: "session";
  scope: Scope;
  /** SHA-256 of the cookie's session id, the `sessions` row key. */
  sessionIdHash: string;
}

export type Caller = SessionCaller;

export interface ApiEnv {
  Bindings: Env;
  Variables: { caller: Caller | null };
}
