import { describe, expect, it } from "vitest";
import {
  BulkCreateCampaignLinksRequest,
  Campaign,
  CampaignLinks,
  CampaignPage,
  CreateCampaignRequest,
  ListCampaignsQuery,
  UpdateCampaignRequest,
} from "./campaigns.ts";

function codes(result: { success: boolean; error?: { issues: { path: PropertyKey[]; code: string; params?: unknown }[] } }) {
  return (
    result.error?.issues.map((i) => ({
      path: i.path.join("."),
      code: (i.params as { code?: string } | undefined)?.code ?? i.code,
    })) ?? []
  );
}

describe("CreateCampaignRequest", () => {
  it("trims the name and leaves the UTM campaign to default", () => {
    expect(CreateCampaignRequest.parse({ name: "  Spring launch ", baseUrl: "https://example.com/spring" })).toEqual({
      name: "Spring launch",
      baseUrl: "https://example.com/spring",
    });
  });

  it("trims the UTM values, keeps their case, and reads an empty utmCampaign as not given and an empty utmId as none", () => {
    expect(
      CreateCampaignRequest.parse({
        name: "Spring",
        baseUrl: "https://example.com/?ref=a#top",
        utmCampaign: " SpringSale ",
        utmId: " Q2 ",
      }),
    ).toEqual({ name: "Spring", baseUrl: "https://example.com/?ref=a#top", utmCampaign: "SpringSale", utmId: "Q2" });
    expect(
      CreateCampaignRequest.parse({ name: "Spring", baseUrl: "https://example.com/", utmCampaign: " ", utmId: "" }),
    ).toEqual({ name: "Spring", baseUrl: "https://example.com/", utmCampaign: undefined, utmId: null });
  });

  it.each([
    ["utm_source", "https://example.com/?utm_source=x"],
    ["a valueless utm_id", "https://example.com/?a=1&utm_id"],
    ["utm_campaign before a fragment", "https://example.com/?utm_campaign=x#top"],
  ])("refuses a base URL with %s as base_url_has_utm", (_, baseUrl) => {
    expect(codes(CreateCampaignRequest.safeParse({ name: "c", baseUrl }))).toEqual([
      { path: "baseUrl", code: "base_url_has_utm" },
    ]);
  });

  it("allows a case-variant UTM_Source in the base URL: it is ordinary query (ADR 0014)", () => {
    expect(CreateCampaignRequest.safeParse({ name: "c", baseUrl: "https://example.com/?UTM_Source=x" }).success).toBe(true);
  });

  it("applies the destination rules to the base URL", () => {
    expect(codes(CreateCampaignRequest.safeParse({ name: "c", baseUrl: "example.com" }))).toEqual([
      { path: "baseUrl", code: "destination_invalid" },
    ]);
  });

  it("refuses an empty or overlong name, unknown fields, and an override other than skip", () => {
    expect(
      codes(
        CreateCampaignRequest.safeParse({
          name: "   ",
          baseUrl: "https://example.com/",
          linkCount: 3,
          screening: "force",
        }),
      ),
    ).toEqual([
      { path: "name", code: "too_small" },
      { path: "screening", code: "invalid_value" },
      { path: "", code: "unrecognized_keys" },
    ]);
    expect(codes(CreateCampaignRequest.safeParse({ name: "n".repeat(101), baseUrl: "https://example.com/" }))).toEqual([
      { path: "name", code: "too_big" },
    ]);
  });
});

describe("UpdateCampaignRequest", () => {
  it("renames, trimming the name", () => {
    expect(UpdateCampaignRequest.parse({ name: " Autumn " })).toEqual({ name: "Autumn" });
    expect(UpdateCampaignRequest.parse({})).toEqual({});
  });

  it("refuses the computed aggregates as read_only_field", () => {
    expect(
      codes(
        UpdateCampaignRequest.safeParse({ linkCount: 1, enabledLinkCount: 1, clickCount: 1, syncPendingLinkCount: 0 }),
      ),
    ).toEqual([
      { path: "linkCount", code: "read_only_field" },
      { path: "enabledLinkCount", code: "read_only_field" },
      { path: "clickCount", code: "read_only_field" },
      { path: "syncPendingLinkCount", code: "read_only_field" },
    ]);
  });
});

describe("BulkCreateCampaignLinksRequest", () => {
  it("trims each item's UTM values, keeps their case, and drops an empty content or term", () => {
    expect(
      BulkCreateCampaignLinksRequest.parse({
        items: [
          { utm: { source: " Newsletter ", medium: "email", content: " ", term: null } },
          { utm: { source: "ig", medium: "social", content: "Story" }, slug: "spring-ig", title: " IG " },
        ],
      }),
    ).toEqual({
      items: [
        { utm: { source: "Newsletter", medium: "email", content: null, term: null } },
        { utm: { source: "ig", medium: "social", content: "Story" }, slug: "spring-ig", title: "IG" },
      ],
    });
  });

  it("needs a source and a medium on every item, and slug rules per item", () => {
    expect(
      codes(
        BulkCreateCampaignLinksRequest.safeParse({
          items: [{ utm: { source: " ", medium: "email" } }, { utm: { source: "a" }, slug: "admin" }],
        }),
      ),
    ).toEqual([
      { path: "items.0.utm.source", code: "too_small" },
      { path: "items.1.utm.medium", code: "invalid_type" },
      { path: "items.1.slug", code: "slug_reserved" },
    ]);
  });

  it("needs at least one item and refuses a destination or a campaign per item", () => {
    expect(codes(BulkCreateCampaignLinksRequest.safeParse({ items: [] }))).toEqual([{ path: "items", code: "too_small" }]);
    expect(
      codes(
        BulkCreateCampaignLinksRequest.safeParse({
          items: [{ utm: { source: "a", medium: "b", campaign: "c" }, destination: "https://example.com" }],
        }),
      ),
    ).toEqual([
      { path: "items.0.utm", code: "unrecognized_keys" },
      { path: "items.0", code: "unrecognized_keys" },
    ]);
  });
});

describe("ListCampaignsQuery", () => {
  it("defaults the limit to 50 and caps it at 200", () => {
    expect(ListCampaignsQuery.parse({})).toEqual({ limit: 50 });
    expect(ListCampaignsQuery.safeParse({ limit: "201" }).success).toBe(false);
  });
});

describe("Campaign", () => {
  const campaign = {
    id: "k3Xq9vTzPa2W",
    name: "Spring launch",
    utmCampaign: "Spring launch",
    utmId: null,
    baseUrl: "https://example.com/spring",
    linkCount: 12,
    enabledLinkCount: 11,
    clickCount: 4821,
    syncPendingLinkCount: 0,
    createdAt: "2026-09-24T02:00:00.000Z",
    updatedAt: "2026-09-24T02:00:00.000Z",
  };

  it("parses the ADR 0009 resource, a page of it and a member list", () => {
    expect(Campaign.parse(campaign)).toEqual(campaign);
    expect(CampaignPage.parse({ items: [campaign], nextCursor: null }).items).toHaveLength(1);
    expect(CampaignLinks.parse({ items: [] })).toEqual({ items: [] });
  });
});
