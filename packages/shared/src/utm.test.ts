import { describe, expect, it } from "vitest";
import { Destination, DESTINATION_MAX_LENGTH } from "./api/links.ts";
import { composeCampaignLink, composeUtm, hasUtmKey, missingUtmCore, parseUtm, type UtmValues, type UtmWarning } from "./utm.ts";

// The golden vectors of ADR 0014 (docs/testing.md): the Worker's campaign rewrite and the admin builder agree on them.
const SPRING: UtmValues = { utm_source: "news letter", utm_medium: "email", utm_campaign: "spring" };

describe("composeUtm", () => {
  it.each<[string, string, UtmValues, string]>([
    [
      "the ADR 0014 example",
      "https://ex.com/p?ref=a#top",
      SPRING,
      "https://ex.com/p?ref=a&utm_source=news%20letter&utm_medium=email&utm_campaign=spring#top",
    ],
    ["no query", "https://ex.com/p", { utm_source: "x" }, "https://ex.com/p?utm_source=x"],
    ["a fragment without a query", "https://ex.com/p#a", { utm_source: "x" }, "https://ex.com/p?utm_source=x#a"],
    ["a ? inside the fragment is not a query", "https://ex.com/p#a?b=1", { utm_source: "x" }, "https://ex.com/p?utm_source=x#a?b=1"],
    ["a query ending in ?", "https://ex.com/p?", { utm_source: "x" }, "https://ex.com/p?utm_source=x"],
    ["a query ending in &", "https://ex.com/p?a=1&", { utm_source: "x" }, "https://ex.com/p?a=1&utm_source=x"],
    [
      "all six keys in the fixed order",
      "https://ex.com/",
      { utm_content: "f", utm_term: "e", utm_campaign: "d", utm_medium: "c", utm_source: "b", utm_id: "a" },
      "https://ex.com/?utm_id=a&utm_source=b&utm_medium=c&utm_campaign=d&utm_term=e&utm_content=f",
    ],
    [
      "existing UTM pairs are removed and re-appended, other pairs keep their bytes and order",
      "https://ex.com/p?utm_medium=old&z=%7e&utm_source=old&a=b+c#f",
      { utm_source: "new", utm_medium: "web" },
      "https://ex.com/p?z=%7e&a=b+c&utm_source=new&utm_medium=web#f",
    ],
    ["no remaining pairs leave no ?", "https://ex.com/p?utm_source=x", {}, "https://ex.com/p"],
    ["no remaining pairs before a fragment", "https://ex.com/p?utm_source=x&#top", {}, "https://ex.com/p#top"],
    ["a bare ? with nothing to add is dropped", "https://ex.com/p?", {}, "https://ex.com/p"],
    ["no UTM values keep the other query as is", "https://ex.com/p?a=1&utm_id=7", {}, "https://ex.com/p?a=1"],
    ["a space is %20, never +", "https://ex.com/", { utm_term: "a b+c" }, "https://ex.com/?utm_term=a%20b%2Bc"],
    [
      "values are encoded with encodeURIComponent",
      "https://ex.com/",
      { utm_content: "ä&=/?#%" },
      "https://ex.com/?utm_content=%C3%A4%26%3D%2F%3F%23%25",
    ],
    ["case is preserved", "https://ex.com/", { utm_source: "Newsletter" }, "https://ex.com/?utm_source=Newsletter"],
    [
      "values are trimmed, empty and whitespace-only values dropped",
      "https://ex.com/",
      { utm_source: "  x  ", utm_medium: "", utm_campaign: "   " },
      "https://ex.com/?utm_source=x",
    ],
    [
      "a duplicate key collapses to one",
      "https://ex.com/p?utm_source=a&utm_source=b",
      { utm_source: "a" },
      "https://ex.com/p?utm_source=a",
    ],
    [
      "UTM_Source is ordinary query and kept",
      "https://ex.com/p?UTM_Source=x",
      { utm_source: "y" },
      "https://ex.com/p?UTM_Source=x&utm_source=y",
    ],
    [
      "a key without = is still a UTM pair",
      "https://ex.com/p?utm_term&a=1",
      { utm_term: "t" },
      "https://ex.com/p?a=1&utm_term=t",
    ],
    [
      "host case, IDN and path escapes are untouched",
      "https://EX.com/caf%C3%A9/%7euser?q=1",
      { utm_id: "1" },
      "https://EX.com/caf%C3%A9/%7euser?q=1&utm_id=1",
    ],
  ])("%s", (_name, destination, values, expected) => {
    expect(composeUtm(destination, values)).toBe(expected);
  });

  it("can produce a result over 2048 characters, which Destination then refuses", () => {
    const base = `https://ex.com/${"p".repeat(2000)}`;
    const composed = composeUtm(base, { utm_campaign: "c".repeat(40) });
    expect(composed).toBe(`${base}?utm_campaign=${"c".repeat(40)}`);
    expect(composed.length).toBe(2069);
    expect(composed.length).toBeGreaterThan(DESTINATION_MAX_LENGTH);
    expect(Destination.safeParse(composed).success).toBe(false);
  });
});

describe("composeCampaignLink", () => {
  it("writes the campaign's shared values and the link's own into the base URL, in compose order", () => {
    const campaign = { baseUrl: "https://shop.example/p?ref=a#top", utmCampaign: "Spring 26", utmId: "Q2" };
    expect(composeCampaignLink(campaign, { source: "news", medium: "email", content: "hero", term: null })).toBe(
      "https://shop.example/p?ref=a&utm_id=Q2&utm_source=news&utm_medium=email&utm_campaign=Spring%2026&utm_content=hero#top",
    );
    expect(composeCampaignLink({ ...campaign, utmId: null }, { source: "a", medium: "b" })).toBe(
      "https://shop.example/p?ref=a&utm_source=a&utm_medium=b&utm_campaign=Spring%2026#top",
    );
  });
});

const EMPTY = { utm_id: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_term: "", utm_content: "" };

describe("parseUtm", () => {
  it.each<[string, string, UtmValues, UtmWarning[]]>([
    [
      "the ADR 0014 example",
      "https://ex.com/p?ref=a&utm_source=news%20letter&utm_medium=email&utm_campaign=spring#top",
      SPRING,
      [],
    ],
    ["no query", "https://ex.com/p", {}, []],
    ["a ? inside the fragment is not a query", "https://ex.com/p#utm_source=x?utm_medium=y", {}, []],
    ["a query ending in ?", "https://ex.com/p?", {}, []],
    ["a query ending in &", "https://ex.com/p?utm_id=7&", { utm_id: "7" }, []],
    ["+ reads as a space", "https://ex.com/?utm_term=a+b", { utm_term: "a b" }, []],
    ["%20 reads as a space", "https://ex.com/?utm_term=a%20b", { utm_term: "a b" }, []],
    ["%2B reads as +", "https://ex.com/?utm_term=a%2Bb", { utm_term: "a+b" }, []],
    ["a pair splits on its first =", "https://ex.com/?utm_content=a=b", { utm_content: "a=b" }, []],
    [
      "a malformed percent sequence is shown raw, with a warning",
      "https://ex.com/?utm_source=a%zz+b&utm_medium=email",
      { utm_source: "a%zz+b", utm_medium: "email" },
      [{ code: "malformed_percent", key: "utm_source" }],
    ],
    [
      "a duplicate key shows its first value, with one warning",
      "https://ex.com/?utm_source=a&utm_source=b&utm_source=c",
      { utm_source: "a" },
      [{ code: "duplicate_key", key: "utm_source" }],
    ],
    [
      "UTM_Source is ordinary query, with a warning",
      "https://ex.com/?UTM_Source=x&utm_medium=y",
      { utm_medium: "y" },
      [{ code: "case_variant_key", key: "UTM_Source" }],
    ],
    ["an empty value reads as an empty field", "https://ex.com/?utm_term=&utm_id", {}, []],
    ["whitespace-only values are kept as entered", "https://ex.com/?utm_term=%20%20", { utm_term: "  " }, []],
    ["other utm_ keys are ordinary query", "https://ex.com/?utm_foo=1", {}, []],
  ])("%s", (_name, destination, values, warnings) => {
    expect(parseUtm(destination)).toEqual({ values: { ...EMPTY, ...values }, warnings });
  });

  it("reads back what compose wrote", () => {
    const values = { utm_id: "42", utm_source: "news letter", utm_medium: "e+mail", utm_campaign: "ä/ö", utm_term: "", utm_content: "x&y" };
    expect(parseUtm(composeUtm("https://ex.com/p?ref=a#top", values))).toEqual({ values, warnings: [] });
  });
});

describe("hasUtmKey", () => {
  it.each<[string, boolean]>([
    ["https://ex.com/?utm_source=x", true],
    ["https://ex.com/?a=1&utm_term=", true],
    ["https://ex.com/?utm_id", true],
    ["https://ex.com/?UTM_Source=x", false],
    ["https://ex.com/?utm_foo=1", false],
    ["https://ex.com/#utm_source=x", false],
    ["https://ex.com/", false],
  ])("%s → %s", (destination, expected) => {
    expect(hasUtmKey(destination)).toBe(expected);
  });
});

describe("missingUtmCore", () => {
  it.each<[UtmValues, string[]]>([
    [{}, []],
    [{ utm_source: "  " }, []],
    [SPRING, []],
    [{ utm_source: "a" }, ["utm_medium", "utm_campaign"]],
    [{ utm_term: "t" }, ["utm_source", "utm_medium", "utm_campaign"]],
    [{ utm_source: "a", utm_medium: "b", utm_campaign: " " }, ["utm_campaign"]],
  ])("%j → %j", (values, expected) => {
    expect(missingUtmCore(values)).toEqual(expected);
  });
});
