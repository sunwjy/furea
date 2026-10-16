import { describe, expect, it } from "vitest";
import { ChangePasswordRequest, Settings, UpdateSettingsRequest } from "./settings.ts";

function codes(result: { success: boolean; error?: { issues: { path: PropertyKey[]; code: string; params?: unknown }[] } }) {
  return (
    result.error?.issues.map((i) => ({
      path: i.path.join("."),
      code: (i.params as { code?: string } | undefined)?.code ?? i.code,
    })) ?? []
  );
}

describe("UpdateSettingsRequest", () => {
  it("accepts a root destination, null to unset it, and an empty patch", () => {
    expect(UpdateSettingsRequest.parse({ rootDestination: "https://example.com/home" })).toEqual({
      rootDestination: "https://example.com/home",
    });
    expect(UpdateSettingsRequest.parse({ rootDestination: null })).toEqual({ rootDestination: null });
    expect(UpdateSettingsRequest.parse({})).toEqual({});
  });

  it("validates the root destination like a link destination", () => {
    expect(codes(UpdateSettingsRequest.safeParse({ rootDestination: "ftp://example.com" }))).toEqual([
      { path: "rootDestination", code: "destination_invalid" },
    ]);
    expect(codes(UpdateSettingsRequest.safeParse({ rootDestination: `https://e.com/${"a".repeat(2040)}` }))).toEqual([
      { path: "rootDestination", code: "destination_invalid" },
    ]);
  });

  it("refuses the read-only fields with any value as read_only_field", () => {
    expect(codes(UpdateSettingsRequest.safeParse({ analyticsConfigured: true, version: "9.9.9" }))).toEqual([
      { path: "analyticsConfigured", code: "read_only_field" },
      { path: "version", code: "read_only_field" },
    ]);
  });

  it("refuses unknown fields", () => {
    expect(codes(UpdateSettingsRequest.safeParse({ theme: "dark" }))).toEqual([
      { path: "", code: "unrecognized_keys" },
    ]);
  });
});

describe("ChangePasswordRequest", () => {
  const current = "the-current-one";

  it("accepts a new password of 12 and of 256 characters", () => {
    for (const newPassword of ["a".repeat(12), "a".repeat(256)]) {
      expect(ChangePasswordRequest.parse({ currentPassword: current, newPassword })).toEqual({
        currentPassword: current,
        newPassword,
      });
    }
  });

  it("has no complexity rules: spaces and non-ASCII are fine", () => {
    const newPassword = "correct horse battery é";
    expect(ChangePasswordRequest.parse({ currentPassword: current, newPassword }).newPassword).toBe(newPassword);
  });

  it.each([
    ["11 characters", "a".repeat(11), "too_small"],
    ["257 characters", "a".repeat(257), "too_big"],
  ])("refuses a new password of %s", (_, newPassword, code) => {
    expect(codes(ChangePasswordRequest.safeParse({ currentPassword: current, newPassword }))).toEqual([
      { path: "newPassword", code },
    ]);
  });

  it("needs both fields", () => {
    expect(codes(ChangePasswordRequest.safeParse({})).map((c) => c.path)).toEqual(["currentPassword", "newPassword"]);
  });
});

describe("Settings", () => {
  it("parses the settings document", () => {
    const document = { rootDestination: null, access: null, analyticsConfigured: false, version: "1.2.3" };
    expect(Settings.parse(document)).toEqual(document);
  });
});
