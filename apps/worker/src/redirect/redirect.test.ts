import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertLink } from "../core/db/links.ts";

const ORIGIN = "https://s.example.com";

function request(path: string, method = "GET"): Promise<Response> {
  return exports.default.fetch(new Request(ORIGIN + path, { method, redirect: "manual" }));
}

async function snapshot(res: Response) {
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    body: await res.text(),
  };
}

beforeAll(async () => {
  await insertLink(env.DB, { slug: "abc123", destination: "https://example.com/landing?x=1" });
  await insertLink(env.DB, { slug: "ABC123", destination: "https://example.com/upper" });
  await insertLink(env.DB, { slug: "off", destination: "https://example.com/off", enabled: false });
  // Rows a correct write path could never create: only the pre-lookup checks keep them unreachable.
  for (const slug of ["_hidden", ".hidden", "a.b", "admin", "Api"]) {
    await env.DB.prepare(
      "INSERT INTO links (slug, destination, created_at, updated_at) VALUES (?, 'https://example.com/x', '', '')",
    )
      .bind(slug)
      .run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a link in D1", () => {
  it("answers 302 to its destination with no-store", async () => {
    const res = await request("/abc123");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/landing?x=1");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is looked up case-sensitively", async () => {
    expect((await request("/ABC123")).headers.get("location")).toBe("https://example.com/upper");
    expect((await request("/Abc123")).status).toBe(404);
  });

  it("logs nothing when it redirects", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    expect((await request("/abc123")).status).toBe(302);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("answers HEAD exactly like GET, without a body", async () => {
    const head = await request("/abc123", "HEAD");
    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toBe("https://example.com/landing?x=1");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");
  });
});

describe("the unknown-slug response", () => {
  it("is a fixed uncached HTML 404", async () => {
    const res = await snapshot(await request("/nope"));
    expect(res.status).toBe(404);
    expect(res.contentType).toBe("text/html; charset=utf-8");
    expect(res.cacheControl).toBe("no-store");
    expect(res.body).toContain("Not found");
  });

  it.each([
    ["root", "/"],
    ["unknown slug", "/nope"],
    ["disabled link", "/off"],
    ["trailing slash", "/abc123/"],
    ["two segments", "/abc123/def"],
    ["api subpath", "/api/v1/links"],
    ["dot in segment", "/a.b"],
    ["encoded space", "/a%20b"],
    ["non-ASCII", "/%C3%A9"],
    ["65 characters", `/${"a".repeat(65)}`],
    ["underscore prefix", "/_hidden"],
    ["dot prefix", "/.hidden"],
    ["dot directory", "/.well-known/security.txt"],
    ["reserved admin", "/admin"],
    ["reserved API in another case", "/Api"],
    ["query string on unknown", "/nope?x=1"],
    ["percent-encoded form of a real slug", "/%61bc123"],
  ])("is returned byte for byte for the %s", async (_, path) => {
    const expected = await snapshot(await request("/nope"));
    expect(await snapshot(await request(path))).toEqual(expected);
  });

  it("answers HEAD with the same status and headers and no body", async () => {
    const get = await request("/nope");
    const head = await request("/nope", "HEAD");
    expect(head.status).toBe(404);
    expect([...head.headers]).toEqual([...get.headers]);
    expect(await head.text()).toBe("");
  });
});

describe("other methods", () => {
  it.each([
    ["POST", "/abc123"],
    ["PUT", "/abc123"],
    ["PATCH", "/nope"],
    ["DELETE", "/abc123"],
    ["OPTIONS", "/"],
    ["POST", "/a.b"],
    ["POST", "/robots.txt"],
  ])("%s %s answers 405 with Allow: GET, HEAD", async (method, path) => {
    const res = await request(path, method);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("robots.txt", () => {
  it("disallows the admin surface and the API, and nothing else", async () => {
    const res = await request("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("User-agent: *\nDisallow: /admin/\nDisallow: /api/\n");
  });

  it("answers HEAD without a body", async () => {
    const res = await request("/robots.txt", "HEAD");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});
