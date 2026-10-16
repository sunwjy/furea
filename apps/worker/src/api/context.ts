import type { Scope } from "@furea/shared";
import type { Env } from "../core/env.ts";

/** Who is calling (ADR 0009, *Who may call what*). */
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

/** The operator, signed in through Cloudflare Access (ADR 0003): a valid Access JWT is the operator session. */
export interface AccessCaller {
  kind: "access";
  scope: Scope;
  email: string | null;
}

export type Caller = SessionCaller | AccessCaller | ApiKeyCaller;

export interface ApiEnv {
  Bindings: Env;
  Variables: { caller: Caller | null };
}
