import { describe, expect, it } from "vitest";
import { campaignUtmKey, foldKey, groupByFoldKey } from "./fold.ts";

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

// ADR 0005: the campaign comparison folds its rows by source or by medium, case-insensitively, from the rows it has.
describe("groupByFoldKey", () => {
  const links = [
    { slug: "a", source: "Newsletter" },
    { slug: "b", source: "instagram" },
    { slug: "c", source: " newsletter " },
    { slug: "d", source: "NEWSLETTER" },
  ];

  it("groups by fold key in order of first appearance, labelled with the first member's trimmed value", () => {
    expect(groupByFoldKey(links, (l) => l.source)).toEqual([
      { key: "newsletter", label: "Newsletter", members: [links[0], links[2], links[3]] },
      { key: "instagram", label: "instagram", members: [links[1]] },
    ]);
  });

  it("returns no groups for no rows", () => {
    expect(groupByFoldKey([], (l: { source: string }) => l.source)).toEqual([]);
  });
});
