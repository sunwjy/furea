import { describe, expect, it } from "vitest";
import { ApiKey, ApiKeyList, CreateApiKeyRequest, CreatedApiKey } from "./api-keys.ts";

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[]; code: string }[] } }) {
  return result.error?.issues.map((i) => ({ path: i.path.join("."), code: i.code })) ?? [];
}

describe("CreateApiKeyRequest", () => {
  it("accepts a name and a scope, trimming the name", () => {
    expect(CreateApiKeyRequest.parse({ name: "  backup script ", scope: "read" })).toEqual({
      name: "backup script",
      scope: "read",
    });
    expect(CreateApiKeyRequest.parse({ name: "x".repeat(64), scope: "write" }).name).toHaveLength(64);
  });

  it("rejects an empty, blank or overlong name", () => {
    for (const name of ["", "   ", "x".repeat(65)]) {
      expect(issues(CreateApiKeyRequest.safeParse({ name, scope: "read" }))).toEqual([
        { path: "name", code: "custom" },
      ]);
    }
  });

  it("rejects a missing or unknown scope and unknown fields", () => {
    expect(issues(CreateApiKeyRequest.safeParse({ name: "ci" }))).toEqual([{ path: "scope", code: "invalid_value" }]);
    expect(issues(CreateApiKeyRequest.safeParse({ name: "ci", scope: "admin" }))).toEqual([
      { path: "scope", code: "invalid_value" },
    ]);
    expect(issues(CreateApiKeyRequest.safeParse({ name: "ci", scope: "read", key: "furea_x" }))).toEqual([
      { path: "", code: "unrecognized_keys" },
    ]);
  });
});

const KEY = {
  id: "k3Xq9vTzPa2W",
  name: "backup script",
  prefix: "Ab3dEf7h",
  scope: "read",
  createdAt: "2026-10-15T00:00:00.000Z",
  lastUsedAt: null,
};

describe("ApiKey", () => {
  it("describes a key without its secret", () => {
    expect(ApiKey.parse(KEY)).toEqual(KEY);
    expect(ApiKey.parse({ ...KEY, lastUsedAt: "2026-10-16T00:00:00.000Z" }).lastUsedAt).toBe(
      "2026-10-16T00:00:00.000Z",
    );
    expect(ApiKeyList.parse([KEY])).toEqual([KEY]);
  });

  it("carries the secret only on the creation answer", () => {
    const created = { ...KEY, key: "furea_Ab3dEf7h" };
    expect(CreatedApiKey.parse(created)).toEqual(created);
    expect(CreatedApiKey.safeParse(KEY).success).toBe(false);
  });
});
