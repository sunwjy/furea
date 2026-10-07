import { describe, expect, it } from "vitest";
import { hashPassword, PASSWORD_ITERATIONS, verifyPassword } from "./password.ts";

// The stored format of the operator password (ADR 0003, docs/testing.md). Computed independently with
// node:crypto's pbkdf2Sync. If this test has to change, already-stored passwords stop verifying: that is a
// `minor` changeset with a re-hash-on-login plan, never a silent edit.
const GOLDEN = {
  password: "correct horse battery staple",
  salt: new TextEncoder().encode("furea-golden-salt"),
  stored: "$pbkdf2-sha256$i=100000$ZnVyZWEtZ29sZGVuLXNhbHQ$Y8YsAjiaN8i0/K8xrlo6/vxIJFfTvbDIQa8qvioB0Po",
};

describe("hashPassword", () => {
  it("reproduces the golden vector from a fixed password and salt", async () => {
    expect(await hashPassword(GOLDEN.password, { salt: GOLDEN.salt })).toBe(GOLDEN.stored);
  });

  it("uses 100,000 iterations, the most Workers' Web Crypto accepts", () => {
    expect(PASSWORD_ITERATIONS).toBe(100_000);
  });

  it("draws a fresh 16-byte salt for every hash", async () => {
    const a = await hashPassword("same password here");
    const b = await hashPassword("same password here");
    expect(a).not.toBe(b);
    const [, tag, iterations, salt, digest] = a.split("$");
    expect(tag).toBe("pbkdf2-sha256");
    expect(iterations).toBe("i=100000");
    expect(atob(salt ?? "")).toHaveLength(16);
    expect(atob(digest ?? "")).toHaveLength(32);
  });
});

describe("verifyPassword", () => {
  it("accepts the golden vector", async () => {
    expect(await verifyPassword(GOLDEN.password, GOLDEN.stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    expect(await verifyPassword("correct horse battery stapler", GOLDEN.stored)).toBe(false);
    expect(await verifyPassword("", GOLDEN.stored)).toBe(false);
  });

  it("round-trips a freshly hashed password", async () => {
    const stored = await hashPassword("a fresh operator password");
    expect(await verifyPassword("a fresh operator password", stored)).toBe(true);
  });

  it("verifies with the iteration count written in the stored string", async () => {
    const stored = await hashPassword("older, cheaper hash", { iterations: 1_000 });
    expect(stored).toContain("$i=1000$");
    expect(await verifyPassword("older, cheaper hash", stored)).toBe(true);
  });

  it.each([
    "",
    "not a hash",
    "$pbkdf2-sha512$i=100000$ZnVyZWEtZ29sZGVuLXNhbHQ$Y8YsAjiaN8i0/K8xrlo6/vxIJFfTvbDIQa8qvioB0Po",
    "$pbkdf2-sha256$i=0$ZnVyZWEtZ29sZGVuLXNhbHQ$Y8YsAjiaN8i0/K8xrlo6/vxIJFfTvbDIQa8qvioB0Po",
    "$pbkdf2-sha256$i=100001$ZnVyZWEtZ29sZGVuLXNhbHQ$Y8YsAjiaN8i0/K8xrlo6/vxIJFfTvbDIQa8qvioB0Po",
    "$pbkdf2-sha256$i=abc$ZnVyZWEtZ29sZGVuLXNhbHQ$Y8YsAjiaN8i0/K8xrlo6/vxIJFfTvbDIQa8qvioB0Po",
    "$pbkdf2-sha256$i=100000$!!!$Y8YsAjiaN8i0/K8xrlo6/vxIJFfTvbDIQa8qvioB0Po",
    "$pbkdf2-sha256$i=100000$ZnVyZWEtZ29sZGVuLXNhbHQ$Y8YsAjiaN8i0",
  ])("returns false for the malformed stored value %j", async (stored) => {
    expect(await verifyPassword(GOLDEN.password, stored)).toBe(false);
  });
});
