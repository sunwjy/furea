import { describe, expect, it } from "vitest";
import {
  GENERATED_SLUG_ALPHABET,
  GENERATED_SLUG_LENGTH,
  generateSlug,
  isCustomSlug,
  isReservedPath,
} from "./slug.ts";

describe("generated slug alphabet", () => {
  it("is base62 minus the six look-alike characters", () => {
    const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const expected = [...base62].filter((c) => !"0Oo1Il".includes(c)).join("");
    expect(GENERATED_SLUG_ALPHABET).toBe(expected);
    expect(GENERATED_SLUG_ALPHABET).toHaveLength(56);
  });
});

describe("generateSlug", () => {
  it("draws six characters from the generated alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const slug = generateSlug();
      expect(slug).toHaveLength(GENERATED_SLUG_LENGTH);
      for (const c of slug) expect(GENERATED_SLUG_ALPHABET).toContain(c);
      expect(isCustomSlug(slug)).toBe(true);
    }
  });

  it("uses every symbol of the alphabet over many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const c of generateSlug()) seen.add(c);
    expect(seen.size).toBe(56);
  });
});

describe("isCustomSlug", () => {
  it.each([
    "a",
    "Z",
    "9",
    "-",
    "_",
    "abc",
    "ABC",
    "launch-2026",
    "snake_case",
    "a".repeat(64),
    "0Oo1Il",
  ])("accepts %j", (slug) => {
    expect(isCustomSlug(slug)).toBe(true);
  });

  it.each([
    "",
    "a".repeat(65),
    "a/b",
    "a b",
    "a.b",
    "abc/",
    "é",
    "a%20b",
    "a+b",
    "a~b",
    "ab\n",
  ])("rejects %j", (slug) => {
    expect(isCustomSlug(slug)).toBe(false);
  });
});

describe("isReservedPath", () => {
  it.each([
    "admin",
    "Admin",
    "ADMIN",
    "api",
    "API",
    "Api",
    "favicon.ico",
    "FAVICON.ICO",
    "robots.txt",
    "Robots.TXT",
    "_",
    "_abc",
    "_root",
    ".",
    ".well-known",
    ".env",
  ])("reserves %j", (segment) => {
    expect(isReservedPath(segment)).toBe(true);
  });

  it.each([
    "",
    "admins",
    "adm",
    "apis",
    "my-api",
    "admin_",
    "favicon",
    "robots",
    "a_",
    "a.",
    "-admin",
  ])("does not reserve %j", (segment) => {
    expect(isReservedPath(segment)).toBe(false);
  });
});
