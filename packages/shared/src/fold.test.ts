import { describe, expect, it } from "vitest";
import { campaignUtmKey, foldKey } from "./fold.ts";

// ADR 0016: the meaning of "compared case-insensitively" for campaign names and UTM combinations.
describe("foldKey", () => {
  it.each<[string, string, string]>([
    ["lower-cases ASCII", "Spring Launch", "spring launch"],
    ["trims surrounding whitespace", "  Newsletter\t", "newsletter"],
    ["keeps inner whitespace as is", "news  letter", "news  letter"],
    ["composes to NFC", "Été", "été"],
    ["folds non-ASCII letters, which SQLite's NOCASE would not", "ÉTÉ", "été"],
    ["is locale-independent (dotted capital I stays two code points)", "İstanbul", "i̇stanbul"],
    ["leaves digits and punctuation alone", "Q3_2026-ad", "q3_2026-ad"],
  ])("%s", (_, value, expected) => {
    expect(foldKey(value)).toBe(expected);
  });

  it("makes case and composition variants equal", () => {
    expect(foldKey("Café")).toBe(foldKey(" CAFÉ "));
  });
});

describe("campaignUtmKey", () => {
  it("is equal for case variants of one combination", () => {
    expect(campaignUtmKey({ source: "Newsletter", medium: "Email", content: null, term: null })).toBe(
      campaignUtmKey({ source: "newsletter ", medium: "email" }),
    );
  });

  it("treats a missing content or term like an empty one", () => {
    expect(campaignUtmKey({ source: "a", medium: "b", content: "", term: "  " })).toBe(
      campaignUtmKey({ source: "a", medium: "b" }),
    );
  });

  it("tells combinations apart even when their values could be joined the same way", () => {
    const keys = [
      campaignUtmKey({ source: "a", medium: "b", content: "c" }),
      campaignUtmKey({ source: "a", medium: "b", term: "c" }),
      campaignUtmKey({ source: "a|b", medium: "c" }),
      campaignUtmKey({ source: "a", medium: "b|c" }),
      campaignUtmKey({ source: 'a","b', medium: "c" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
