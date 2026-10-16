import { describe, expect, it } from "vitest";
import { matchAdopt, type AdoptCampaign } from "./adopt.ts";
import { campaignUtmKey } from "./fold.ts";

// ADR 0014 *Adopt*: one accept case and one case per adopt_mismatch reason code (docs/testing.md).
const SPRING: AdoptCampaign = { baseUrl: "https://shop.example/p?ref=a#top", utmCampaign: "Spring 26", utmId: null };
const NONE = new Set<string>();

describe("matchAdopt", () => {
  it("accepts reordered, differently encoded UTM pairs and gives the canonical destination", () => {
    const match = matchAdopt(
      "https://shop.example/p?utm_medium=email&ref=a&utm_campaign=Spring+26&utm_source=news%20letter#top",
      SPRING,
      NONE,
    );
    expect(match).toEqual({
      ok: true,
      destination: "https://shop.example/p?ref=a&utm_source=news%20letter&utm_medium=email&utm_campaign=Spring%2026#top",
      utm: { source: "news letter", medium: "email", content: null, term: null },
      utmKey: campaignUtmKey({ source: "news letter", medium: "email" }),
    });
  });

  it("keeps content and term and matches the campaign's utm_id", () => {
    const match = matchAdopt(
      "https://shop.example/p?ref=a&utm_content=hero&utm_id=Q2&utm_term=shoes&utm_source=ad&utm_medium=cpc&utm_campaign=Spring%2026#top",
      { ...SPRING, utmId: "Q2" },
      NONE,
    );
    expect(match).toMatchObject({
      ok: true,
      destination:
        "https://shop.example/p?ref=a&utm_id=Q2&utm_source=ad&utm_medium=cpc&utm_campaign=Spring%2026&utm_term=shoes&utm_content=hero#top",
      utm: { source: "ad", medium: "cpc", content: "hero", term: "shoes" },
    });
  });

  it.each<[string, string, AdoptCampaign, string]>([
    [
      "base_url_mismatch: another path",
      "https://shop.example/q?ref=a&utm_source=x&utm_medium=y&utm_campaign=Spring%2026#top",
      SPRING,
      "base_url_mismatch",
    ],
    [
      "base_url_mismatch: the other pairs in another order",
      "https://shop.example/p?b=1&ref=a&utm_source=x&utm_medium=y&utm_campaign=Spring%2026#top",
      { ...SPRING, baseUrl: "https://shop.example/p?ref=a&b=1#top" },
      "base_url_mismatch",
    ],
    [
      "utm_campaign_mismatch: another value",
      "https://shop.example/p?ref=a&utm_source=x&utm_medium=y&utm_campaign=spring%2026#top",
      SPRING,
      "utm_campaign_mismatch",
    ],
    [
      "utm_campaign_mismatch: absent",
      "https://shop.example/p?ref=a&utm_source=x&utm_medium=y#top",
      SPRING,
      "utm_campaign_mismatch",
    ],
    [
      "utm_id_mismatch: present when the campaign has none",
      "https://shop.example/p?ref=a&utm_id=7&utm_source=x&utm_medium=y&utm_campaign=Spring%2026#top",
      SPRING,
      "utm_id_mismatch",
    ],
    [
      "utm_id_mismatch: absent when the campaign has one",
      "https://shop.example/p?ref=a&utm_source=x&utm_medium=y&utm_campaign=Spring%2026#top",
      { ...SPRING, utmId: "Q2" },
      "utm_id_mismatch",
    ],
    [
      "utm_missing: no medium",
      "https://shop.example/p?ref=a&utm_source=x&utm_campaign=Spring%2026#top",
      SPRING,
      "utm_missing",
    ],
    [
      "utm_value_untrimmed: a source with a leading space",
      "https://shop.example/p?ref=a&utm_source=%20x&utm_medium=y&utm_campaign=Spring%2026#top",
      SPRING,
      "utm_value_untrimmed",
    ],
    [
      "utm_value_untrimmed: a whitespace-only content",
      "https://shop.example/p?ref=a&utm_source=x&utm_medium=y&utm_campaign=Spring%2026&utm_content=+#top",
      SPRING,
      "utm_value_untrimmed",
    ],
    [
      "duplicate_utm_key: a key twice",
      "https://shop.example/p?ref=a&utm_source=x&utm_source=x&utm_medium=y&utm_campaign=Spring%2026#top",
      SPRING,
      "duplicate_utm_key",
    ],
    [
      "duplicate_utm_key: a case-variant key",
      "https://shop.example/p?ref=a&utm_source=x&UTM_Medium=y&utm_medium=y&utm_campaign=Spring%2026#top",
      SPRING,
      "duplicate_utm_key",
    ],
  ])("refuses with %s", (_, destination, campaign, reason) => {
    expect(matchAdopt(destination, campaign, NONE)).toEqual({ ok: false, reason });
  });

  it("refuses with utm_combination_taken when a member holds the combination, ignoring case", () => {
    const taken = new Set([campaignUtmKey({ source: "Newsletter", medium: "email" })]);
    const match = matchAdopt(
      "https://shop.example/p?ref=a&utm_source=newsletter&utm_medium=Email&utm_campaign=Spring%2026#top",
      SPRING,
      taken,
    );
    expect(match).toEqual({ ok: false, reason: "utm_combination_taken" });
  });
});
