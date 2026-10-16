import { describe, expect, it } from "vitest";
import { isNewer } from "./version.ts";

describe("version order for the deploy gate", () => {
  it.each([
    ["0.2.0", "0.1.0", true],
    ["0.1.0", "0.2.0", false],
    ["0.1.0", "0.1.0", false],
    ["0.10.0", "0.9.3", true],
    ["1.0.0", "0.99.99", true],
    // Snapshots (ADR 0010) are older than any release, even the one they were cut from.
    ["0.0.0-abc1234-20260923120000", "0.0.0", false],
    ["0.3.0-abc1234-20260923120000", "0.1.0", false],
    ["0.1.0", "0.3.0-abc1234-20260923120000", true],
    // Between snapshots, the later build wins.
    ["0.0.0-def5678-20261001000000", "0.0.0-abc1234-20260923120000", true],
    ["0.0.0-abc1234-20260923120000", "0.0.0-def5678-20261001000000", false],
  ])("%s is newer than %s: %s", (a, b, expected) => {
    expect(isNewer(a, b)).toBe(expected);
  });

  it("refuses a version it cannot read", () => {
    expect(() => isNewer("latest", "0.1.0")).toThrow(/latest/);
  });
});
