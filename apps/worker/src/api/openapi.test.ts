import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function fetchDocument(): Promise<Response> {
  return exports.default.fetch(new Request("https://s.example.com/api/v1/openapi.json"));
}

describe("GET /api/v1/openapi.json", () => {
  it("answers without authentication", async () => {
    const res = await fetchDocument();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  // The committed snapshot is how an API change shows up in review (docs/testing.md); `vitest -u` rewrites it.
  it("matches the committed snapshot", async () => {
    const document = await (await fetchDocument()).json();
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot("./openapi.snapshot.json");
  });

  it("is an OpenAPI 3.1 document whose every reference resolves", async () => {
    const document = (await (await fetchDocument()).json()) as {
      openapi: string;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.openapi).toBe("3.1.0");
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(document.components.schemas).toHaveProperty(ref as string);
  });
});
