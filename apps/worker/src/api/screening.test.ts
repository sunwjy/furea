// Destination screening on the writes that set a destination (ADR 0013), against the canned resolver of test/doh.ts.

import { Campaign, CreatedApiKey, Link } from "@furea/shared";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { doh } from "../../test/doh.ts";
import { SESSION_COOKIE, startSession } from "./session.ts";

const ORIGIN = "https://s.example.com";

let cookie: string;
let writeKey: string;
let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;

beforeAll(async () => {
  const { id } = await startSession(env.DB);
  cookie = `${SESSION_COOKIE}=${id}`;
  const res = await api("POST", "/api-keys", { name: "screening write", scope: "write" });
  writeKey = CreatedApiKey.parse(await res.json()).key;
});

beforeEach(async () => {
  doh.reset();
  await env.DB.exec("DELETE FROM settings WHERE key IN ('root_destination', 'root_destination_sync_pending')");
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function api(method: string, path: string, body?: unknown, init: { bearer?: string } = {}): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN });
  if (init.bearer !== undefined) headers.set("authorization", `Bearer ${init.bearer}`);
  else headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  return exports.default.fetch(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function flaggedDetails(res: Response) {
  expect(res.status).toBe(422);
  const body = (await res.json()) as { error: { code: string; details: { field: string; host: string; code: string }[] } };
  expect(body.error.code).toBe("destination_flagged");
  return body.error.details.map(({ field, host, code }) => ({ field, host, code }));
}

const logged = (spy: MockInstance, event: string) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).filter((l) => l["event"] === event);

describe("POST /api/v1/links", () => {
  it("looks the destination's host up and creates a clean link", async () => {
    const res = await api("POST", "/links", { destination: "https://clean.example/a", slug: "scr-clean" });
    expect(res.status).toBe(201);
    expect(doh.lookups).toEqual(["clean.example"]);
  });

  it("refuses a flagged destination with 422 destination_flagged naming the host, and stores nothing", async () => {
    doh.flag("malware.testcategory.com");
    const res = await api("POST", "/links", { destination: "https://malware.testcategory.com/x", slug: "scr-bad" });
    expect(await flaggedDetails(res)).toEqual([
      { field: "destination", host: "malware.testcategory.com", code: "destination_flagged" },
    ]);
    expect((await api("GET", "/links/scr-bad")).status).toBe(404);
  });

  it("does not look up an IP-literal destination", async () => {
    const res = await api("POST", "/links", { destination: "http://192.0.2.7/x", slug: "scr-ip" });
    expect(res.status).toBe(201);
    expect(doh.lookups).toEqual([]);
  });

  it("creates a flagged destination with the session override, logs screening_overridden and stores no flag", async () => {
    doh.flag("bad.example");
    const res = await api("POST", "/links", { destination: "https://bad.example/", slug: "scr-skip", screening: "skip" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("screening");
    expect(Link.parse(body).destination).toBe("https://bad.example/");
    expect(logged(warn, "screening_overridden")).toEqual([{ event: "screening_overridden", slug: "scr-skip" }]);
  });

  it("logs the generated slug when the override creates a link without one", async () => {
    doh.flag("bad.example");
    const res = await api("POST", "/links", { destination: "https://bad.example/", screening: "skip" });
    const link = Link.parse(await res.json());
    expect(logged(warn, "screening_overridden")).toEqual([{ event: "screening_overridden", slug: link.slug }]);
  });

  it("refuses the override from an API key with 403 forbidden, whatever the key's scope, and stores nothing", async () => {
    const res = await api(
      "POST",
      "/links",
      { destination: "https://clean.example/", slug: "scr-key-skip", screening: "skip" },
      { bearer: writeKey },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect((await api("GET", "/links/scr-key-skip")).status).toBe(404);
  });

  it("screens an API key's write like a session's", async () => {
    doh.flag("bad.example");
    const res = await api("POST", "/links", { destination: "https://bad.example/" }, { bearer: writeKey });
    expect(await flaggedDetails(res)).toEqual([{ field: "destination", host: "bad.example", code: "destination_flagged" }]);
  });

  it("accepts only the value skip", async () => {
    const res = await api("POST", "/links", { destination: "https://clean.example/", screening: "off" });
    expect(res.status).toBe(400);
  });

  it("fails open when the resolver is unavailable and logs screening_unavailable with the slug", async () => {
    doh.goDown();
    const res = await api("POST", "/links", { destination: "https://any.example/", slug: "scr-down" });
    expect(res.status).toBe(201);
    expect(logged(error, "screening_unavailable")).toEqual([{ event: "screening_unavailable", slug: "scr-down" }]);
  });
});

describe("PATCH /api/v1/links/:slug", () => {
  it("screens a new destination, even on the host the link already has", async () => {
    expect((await api("POST", "/links", { destination: "https://turned.example/a", slug: "scr-turned" })).status).toBe(201);
    doh.flag("turned.example");
    const res = await api("PATCH", "/links/scr-turned", { destination: "https://turned.example/b" });
    expect(await flaggedDetails(res)).toEqual([
      { field: "destination", host: "turned.example", code: "destination_flagged" },
    ]);
    const link = Link.parse(await (await api("GET", "/links/scr-turned")).json());
    expect(link.destination).toBe("https://turned.example/a");
  });

  it("does not look anything up when the patch leaves the destination alone", async () => {
    expect((await api("POST", "/links", { destination: "https://calm.example/", slug: "scr-title" })).status).toBe(201);
    doh.reset();
    doh.flag("calm.example");
    const res = await api("PATCH", "/links/scr-title", { title: "renamed", enabled: false });
    expect(res.status).toBe(200);
    expect(doh.lookups).toEqual([]);
  });

  it("saves a flagged destination with the session override and logs the slug", async () => {
    expect((await api("POST", "/links", { destination: "https://ok.example/", slug: "scr-save" })).status).toBe(201);
    doh.flag("bad.example");
    const res = await api("PATCH", "/links/scr-save", { destination: "https://bad.example/", screening: "skip" });
    expect(res.status).toBe(200);
    expect(Link.parse(await res.json()).destination).toBe("https://bad.example/");
    expect(logged(warn, "screening_overridden")).toEqual([{ event: "screening_overridden", slug: "scr-save" }]);
  });

  it("refuses the override from an API key", async () => {
    expect((await api("POST", "/links", { destination: "https://ok.example/", slug: "scr-key" })).status).toBe(201);
    const res = await api("PATCH", "/links/scr-key", { title: "x", screening: "skip" }, { bearer: writeKey });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/v1/settings", () => {
  it("refuses a flagged root destination naming rootDestination, and leaves it unset", async () => {
    doh.flag("bad.example");
    const res = await api("PATCH", "/settings", { rootDestination: "https://bad.example/home" });
    expect(await flaggedDetails(res)).toEqual([
      { field: "rootDestination", host: "bad.example", code: "destination_flagged" },
    ]);
    const settings = (await (await api("GET", "/settings")).json()) as { rootDestination: string | null };
    expect(settings.rootDestination).toBeNull();
  });

  it("saves it with the session override and logs screening_overridden with slug _", async () => {
    doh.flag("bad.example");
    const res = await api("PATCH", "/settings", { rootDestination: "https://bad.example/", screening: "skip" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rootDestination: string }).rootDestination).toBe("https://bad.example/");
    expect(logged(warn, "screening_overridden")).toEqual([{ event: "screening_overridden", slug: "_" }]);
  });

  it("refuses the override from an API key", async () => {
    const res = await api("PATCH", "/settings", { rootDestination: "https://ok.example/", screening: "skip" }, { bearer: writeKey });
    expect(res.status).toBe(403);
  });

  it("does not look anything up when unsetting the root destination", async () => {
    expect((await api("PATCH", "/settings", { rootDestination: null })).status).toBe(200);
    expect(doh.lookups).toEqual([]);
  });

  it("fails open and logs screening_unavailable with slug _", async () => {
    doh.goDown();
    const res = await api("PATCH", "/settings", { rootDestination: "https://any.example/" });
    expect(res.status).toBe(200);
    expect(logged(error, "screening_unavailable")).toEqual([{ event: "screening_unavailable", slug: "_" }]);
  });
});

describe("POST /api/v1/campaigns", () => {
  it("refuses a flagged base URL naming baseUrl, and creates no campaign", async () => {
    doh.flag("bad.example");
    const res = await api("POST", "/campaigns", { name: "Scr flagged", baseUrl: "https://bad.example/spring" });
    expect(await flaggedDetails(res)).toEqual([{ field: "baseUrl", host: "bad.example", code: "destination_flagged" }]);
    const page = (await (await api("GET", "/campaigns?q=Scr%20flagged")).json()) as { items: unknown[] };
    expect(page.items).toEqual([]);
  });

  it("creates it with the session override and logs screening_overridden with the campaign id", async () => {
    doh.flag("bad.example");
    const res = await api("POST", "/campaigns", { name: "Scr skip", baseUrl: "https://bad.example/", screening: "skip" });
    expect(res.status).toBe(201);
    const { id } = Campaign.parse(await res.json());
    expect(logged(warn, "screening_overridden")).toEqual([{ event: "screening_overridden", campaign: id }]);
  });

  it("refuses the override from an API key", async () => {
    const body = { name: "Scr key", baseUrl: "https://ok.example/", screening: "skip" };
    expect((await api("POST", "/campaigns", body, { bearer: writeKey })).status).toBe(403);
  });
});

describe("POST /api/v1/campaigns/:id/links", () => {
  async function campaignOn(name: string, baseUrl: string): Promise<string> {
    const res = await api("POST", "/campaigns", { name, baseUrl });
    expect(res.status).toBe(201);
    return Campaign.parse(await res.json()).id;
  }

  const items = [
    { utm: { source: "a", medium: "m" }, slug: "scr-bulk-a" },
    { utm: { source: "b", medium: "m" }, slug: "scr-bulk-b" },
  ];

  it("looks the base URL's host up once for all items", async () => {
    const id = await campaignOn("Scr bulk clean", "https://shared.example/");
    doh.reset();
    expect((await api("POST", `/campaigns/${id}/links`, { items })).status).toBe(201);
    expect(doh.lookups).toEqual(["shared.example"]);
  });

  it("refuses the whole request when the host is flagged since, creating nothing", async () => {
    const id = await campaignOn("Scr bulk flagged", "https://turns.example/");
    doh.flag("turns.example");
    const res = await api("POST", `/campaigns/${id}/links`, {
      items: [{ utm: { source: "a", medium: "m" }, slug: "scr-bulk-c" }],
    });
    expect(await flaggedDetails(res)).toEqual([{ field: "baseUrl", host: "turns.example", code: "destination_flagged" }]);
    expect((await api("GET", "/links/scr-bulk-c")).status).toBe(404);
  });

  it("creates them with the session override, logging each slug, and refuses the override from an API key", async () => {
    const id = await campaignOn("Scr bulk skip", "https://turns2.example/");
    doh.flag("turns2.example");
    const body = { items: [{ utm: { source: "a", medium: "m" }, slug: "scr-bulk-d" }], screening: "skip" };
    expect((await api("POST", `/campaigns/${id}/links`, body, { bearer: writeKey })).status).toBe(403);
    expect((await api("POST", `/campaigns/${id}/links`, body)).status).toBe(201);
    expect(logged(warn, "screening_overridden")).toEqual([{ event: "screening_overridden", slug: "scr-bulk-d" }]);
  });
});

describe("the redirect path", () => {
  it("never screens", async () => {
    expect((await api("POST", "/links", { destination: "https://later.example/", slug: "scr-redirect" })).status).toBe(201);
    doh.reset();
    doh.flag("later.example");
    const res = await exports.default.fetch(new Request(`${ORIGIN}/scr-redirect`, { redirect: "manual" }));
    expect(res.status).toBe(302);
    expect(doh.lookups).toEqual([]);
  });
});
