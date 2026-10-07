import { describe, expect, it } from "vitest";
import { LoginMethodResponse, LoginRequest, SessionResponse } from "./auth.ts";
import { ErrorEnvelope } from "./errors.ts";

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[]; code: string }[] } }) {
  return result.error?.issues.map((i) => ({ path: i.path.join("."), code: i.code })) ?? [];
}

describe("LoginRequest", () => {
  it("accepts a password", () => {
    expect(LoginRequest.parse({ password: "an operator password" })).toEqual({ password: "an operator password" });
  });

  it("rejects a missing, empty or overlong password", () => {
    expect(issues(LoginRequest.safeParse({}))).toEqual([{ path: "password", code: "invalid_type" }]);
    expect(issues(LoginRequest.safeParse({ password: "" }))).toEqual([{ path: "password", code: "too_small" }]);
    expect(issues(LoginRequest.safeParse({ password: "x".repeat(257) }))).toEqual([
      { path: "password", code: "too_big" },
    ]);
  });

  it("rejects unknown fields", () => {
    expect(issues(LoginRequest.safeParse({ password: "an operator password", user: "admin" }))).toEqual([
      { path: "", code: "unrecognized_keys" },
    ]);
  });
});

describe("LoginMethodResponse", () => {
  it("names the open door", () => {
    expect(LoginMethodResponse.parse({ method: "password" })).toEqual({ method: "password" });
    expect(LoginMethodResponse.parse({ method: "access" })).toEqual({ method: "access" });
    expect(LoginMethodResponse.safeParse({ method: "passkey" }).success).toBe(false);
  });
});

describe("SessionResponse", () => {
  it("describes a browser session", () => {
    const session = { kind: "session", scope: "write", apiKey: null };
    expect(SessionResponse.parse(session)).toEqual(session);
  });

  it("describes an API key caller", () => {
    const key = { kind: "apiKey", scope: "read", apiKey: { id: "k3Xq9vTzPa2W", name: "backup script" } };
    expect(SessionResponse.parse(key)).toEqual(key);
  });

  it("rejects an unknown kind or scope", () => {
    expect(SessionResponse.safeParse({ kind: "cookie", scope: "write", apiKey: null }).success).toBe(false);
    expect(SessionResponse.safeParse({ kind: "session", scope: "admin", apiKey: null }).success).toBe(false);
  });
});

describe("ErrorEnvelope", () => {
  it("parses an error with and without details", () => {
    expect(ErrorEnvelope.parse({ error: { code: "invalid_password", message: "Wrong password." } })).toEqual({
      error: { code: "invalid_password", message: "Wrong password." },
    });
    const withDetails = {
      error: {
        code: "validation_failed",
        message: "The request is invalid.",
        details: [{ field: "password", code: "invalid", message: "Required." }],
      },
    };
    expect(ErrorEnvelope.parse(withDetails)).toEqual(withDetails);
  });

  it("rejects a body that is not an envelope", () => {
    expect(ErrorEnvelope.safeParse({ code: "internal" }).success).toBe(false);
  });
});
