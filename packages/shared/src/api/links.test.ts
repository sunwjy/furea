import { describe, expect, it } from "vitest";
import { CreateLinkRequest, Link, LinkPage, ListLinksQuery, UpdateLinkRequest } from "./links.ts";

function codes(result: { success: boolean; error?: { issues: { path: PropertyKey[]; code: string; params?: unknown }[] } }) {
  return (
    result.error?.issues.map((i) => ({
      path: i.path.join("."),
      code: (i.params as { code?: string } | undefined)?.code ?? i.code,
    })) ?? []
  );
}

describe("CreateLinkRequest", () => {
  it("accepts a destination alone", () => {
    expect(CreateLinkRequest.parse({ destination: "https://example.com/a?b=c#d" })).toEqual({
      destination: "https://example.com/a?b=c#d",
    });
  });

  it("accepts a custom slug and trims the title", () => {
    expect(
      CreateLinkRequest.parse({ destination: "http://example.com", slug: "Spring_launch-2026", title: "  Launch  " }),
    ).toEqual({ destination: "http://example.com", slug: "Spring_launch-2026", title: "Launch" });
  });

  it("stores an empty or whitespace-only title as null", () => {
    expect(CreateLinkRequest.parse({ destination: "https://example.com", title: "   " })).toMatchObject({ title: null });
    expect(CreateLinkRequest.parse({ destination: "https://example.com", title: null })).toMatchObject({ title: null });
  });

  it.each([
    ["a relative URL", "/relative"],
    ["no scheme", "example.com"],
    ["ftp", "ftp://example.com/file"],
    ["javascript", "javascript:alert(1)"],
    ["mailto", "mailto:a@example.com"],
    ["a space", "https://example.com/a b"],
    ["a newline", "https://example.com/a\nb"],
    ["leading whitespace", " https://example.com"],
    ["non-ASCII", "https://example.com/é"],
    ["over 2048 characters", `https://example.com/${"a".repeat(2029)}`],
  ])("rejects a destination with %s as destination_invalid", (_, destination) => {
    expect(codes(CreateLinkRequest.safeParse({ destination }))).toEqual([
      { path: "destination", code: "destination_invalid" },
    ]);
  });

  it("accepts a destination of exactly 2048 characters", () => {
    const destination = `https://example.com/${"a".repeat(2028)}`;
    expect(destination).toHaveLength(2048);
    expect(CreateLinkRequest.safeParse({ destination }).success).toBe(true);
  });

  it.each([
    ["slug_invalid", "has space"],
    ["slug_invalid", "a.b"],
    ["slug_invalid", ""],
    ["slug_invalid", "a".repeat(65)],
    ["slug_reserved", "admin"],
    ["slug_reserved", "API"],
    ["slug_reserved", "_private"],
  ])("rejects a slug as %s: %j", (code, slug) => {
    expect(codes(CreateLinkRequest.safeParse({ destination: "https://example.com", slug }))).toEqual([
      { path: "slug", code },
    ]);
  });

  it("rejects a title over 200 characters after trimming", () => {
    expect(CreateLinkRequest.safeParse({ destination: "https://example.com", title: ` ${"t".repeat(200)} ` }).success).toBe(
      true,
    );
    expect(codes(CreateLinkRequest.safeParse({ destination: "https://example.com", title: "t".repeat(201) }))).toEqual([
      { path: "title", code: "title_too_long" },
    ]);
  });

  it("reports every failing field at once, unknown fields included", () => {
    expect(codes(CreateLinkRequest.safeParse({ destination: "nope", slug: "admin", enabled: false }))).toEqual([
      { path: "destination", code: "destination_invalid" },
      { path: "slug", code: "slug_reserved" },
      { path: "", code: "unrecognized_keys" },
    ]);
  });

  it("requires a destination", () => {
    expect(codes(CreateLinkRequest.safeParse({}))).toEqual([{ path: "destination", code: "invalid_type" }]);
  });
});

describe("UpdateLinkRequest", () => {
  it("accepts an empty patch", () => {
    expect(UpdateLinkRequest.parse({})).toEqual({});
  });

  it("keeps only the fields present, trims the title and reads null as clearing it", () => {
    expect(UpdateLinkRequest.parse({ destination: "https://example.com/b", title: "  New  ", enabled: false })).toEqual({
      destination: "https://example.com/b",
      title: "New",
      enabled: false,
    });
    expect(UpdateLinkRequest.parse({ title: null })).toEqual({ title: null });
    expect(UpdateLinkRequest.parse({ title: "  " })).toEqual({ title: null });
  });

  it("refuses a slug as slug_immutable, whatever its value", () => {
    expect(codes(UpdateLinkRequest.safeParse({ slug: "other" }))).toEqual([{ path: "slug", code: "slug_immutable" }]);
    expect(codes(UpdateLinkRequest.safeParse({ slug: null }))).toEqual([{ path: "slug", code: "slug_immutable" }]);
  });

  it("reports every failing field", () => {
    expect(
      codes(UpdateLinkRequest.safeParse({ destination: "ftp://x", title: "t".repeat(201), enabled: "no", extra: 1 })),
    ).toEqual([
      { path: "destination", code: "destination_invalid" },
      { path: "title", code: "title_too_long" },
      { path: "enabled", code: "invalid_type" },
      { path: "", code: "unrecognized_keys" },
    ]);
  });

  it("merge-patches a campaign link's own UTM values: trimmed, case kept, empty or null content/term for none", () => {
    expect(UpdateLinkRequest.parse({ utm: { source: " Newsletter " } })).toEqual({ utm: { source: "Newsletter" } });
    expect(UpdateLinkRequest.parse({ utm: { medium: "Email", content: "  ", term: null } })).toEqual({
      utm: { medium: "Email", content: null, term: null },
    });
  });

  it("refuses a null or empty source or medium, and unknown UTM fields", () => {
    expect(codes(UpdateLinkRequest.safeParse({ utm: { source: null, medium: " ", campaign: "x" } }))).toEqual([
      { path: "utm.source", code: "invalid_type" },
      { path: "utm.medium", code: "too_small" },
      { path: "utm", code: "unrecognized_keys" },
    ]);
  });

  it("refuses null for destination and enabled", () => {
    expect(UpdateLinkRequest.safeParse({ destination: null }).success).toBe(false);
    expect(UpdateLinkRequest.safeParse({ enabled: null }).success).toBe(false);
  });
});

describe("ListLinksQuery", () => {
  it("defaults limit to 50", () => {
    expect(ListLinksQuery.parse({})).toEqual({ limit: 50 });
  });

  it("reads limit, cursor and q from query-string values", () => {
    expect(ListLinksQuery.parse({ limit: "200", cursor: "abc", q: "launch" })).toEqual({
      limit: 200,
      cursor: "abc",
      q: "launch",
    });
  });

  it.each(["0", "201", "1.5", "ten", ""])("rejects limit %j", (limit) => {
    expect(codes(ListLinksQuery.safeParse({ limit })).map((c) => c.path)).toEqual(["limit"]);
  });
});

const LINK = {
  slug: "Ab3xYz",
  shortUrl: "https://s.example.com/Ab3xYz",
  destination: "https://example.com/some/page",
  title: "Launch post",
  enabled: true,
  clickCount: 1234,
  cacheSynced: true,
  campaign: null,
  utm: null,
  createdAt: "2026-09-23T04:12:09.000Z",
  updatedAt: "2026-09-23T04:12:09Z",
};

describe("Link", () => {
  it("parses the ADR 0009 resource", () => {
    expect(Link.parse(LINK)).toEqual(LINK);
  });

  it("rejects a resource with a missing field or a non-ISO timestamp", () => {
    const { clickCount: _, ...missing } = LINK;
    expect(Link.safeParse(missing).success).toBe(false);
    expect(Link.safeParse({ ...LINK, createdAt: "yesterday" }).success).toBe(false);
  });
});

describe("LinkPage", () => {
  it("parses a page with and without a next cursor", () => {
    expect(LinkPage.parse({ items: [LINK], nextCursor: "abc" })).toEqual({ items: [LINK], nextCursor: "abc" });
    expect(LinkPage.parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    expect(LinkPage.safeParse({ items: [] }).success).toBe(false);
    expect(LinkPage.safeParse({ items: [{ ...LINK, enabled: "yes" }], nextCursor: null }).success).toBe(false);
  });
});
