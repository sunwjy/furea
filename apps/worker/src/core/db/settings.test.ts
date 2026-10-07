import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getOrCreateSetting, getSetting, setSetting } from "./settings.ts";

describe("settings", () => {
  it("returns null for a key that was never set", async () => {
    await env.DB.exec("DELETE FROM settings WHERE key = 'operator_password_hash'");
    expect(await getSetting(env.DB, "operator_password_hash")).toBeNull();
  });

  it("writes a value and overwrites it", async () => {
    await setSetting(env.DB, "operator_password_hash", "first");
    expect(await getSetting(env.DB, "operator_password_hash")).toBe("first");
    await setSetting(env.DB, "operator_password_hash", "second");
    expect(await getSetting(env.DB, "operator_password_hash")).toBe("second");
  });

  it("creates a value once and keeps it on later calls", async () => {
    await env.DB.exec("DELETE FROM settings WHERE key = 'login_ip_salt'");
    expect(await getOrCreateSetting(env.DB, "login_ip_salt", () => "made-first")).toBe("made-first");
    expect(await getOrCreateSetting(env.DB, "login_ip_salt", () => "made-later")).toBe("made-first");
    expect(await getSetting(env.DB, "login_ip_salt")).toBe("made-first");
  });
});
