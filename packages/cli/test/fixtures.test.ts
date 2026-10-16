import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare/client.ts";
import { type Fixture, recordingFetch, replayFetch, sanitize } from "./fixtures.ts";

const REAL_TOKEN = "cfat_s3cr3tS3cr3tS3cr3t";
const REAL_ACCOUNT = "9a7806061c88ada191ed06f989cc3dac";

// Stands in for api.cloudflare.com while recording.
const upstream = (async (input: string | URL | Request) => {
  const url = String(input);
  const body = url.endsWith("/workers/domains")
    ? { success: true, result: [{ id: "dom-77", hostname: "go.acme.dev", zone_id: "zone-55", zone_name: "acme.dev", service: "furea" }] }
    : { success: true, result: { uuid: "d1-uuid-1234", name: "furea", owner: "alice@acme.dev" } };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

describe("fixture recording", () => {
  it("replaces the token, account id, resource ids, hostnames and e-mail addresses with placeholders", async () => {
    const recorder = recordingFetch(upstream);
    const client = new CloudflareClient({ token: REAL_TOKEN, fetch: recorder.fetch });
    await client.request("POST", `/accounts/${REAL_ACCOUNT}/d1/database`, { name: "furea" });
    await client.request("GET", `/accounts/${REAL_ACCOUNT}/d1/database/d1-uuid-1234`);
    await client.request("GET", `/accounts/${REAL_ACCOUNT}/workers/domains`);

    const fixture = sanitize({ interactions: recorder.interactions }, [
      [REAL_TOKEN, "cfat_TOKEN"],
      [REAL_ACCOUNT, "ACCOUNT_ID"],
    ]);

    expect(fixture).toEqual({
      interactions: [
        {
          request: {
            method: "POST",
            url: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/d1/database",
            authorization: "Bearer cfat_TOKEN",
            body: { name: "furea" },
          },
          response: { status: 200, body: { success: true, result: { uuid: "ID_1", name: "furea", owner: "operator@example.com" } } },
        },
        {
          request: {
            method: "GET",
            url: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/d1/database/ID_1",
            authorization: "Bearer cfat_TOKEN",
          },
          response: { status: 200, body: { success: true, result: { uuid: "ID_1", name: "furea", owner: "operator@example.com" } } },
        },
        {
          request: {
            method: "GET",
            url: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/workers/domains",
            authorization: "Bearer cfat_TOKEN",
          },
          response: {
            status: 200,
            body: {
              success: true,
              result: [
                { id: "ID_2", hostname: "host-1.example.com", zone_id: "ID_3", zone_name: "host-2.example.com", service: "furea" },
              ],
            },
          },
        },
      ],
    });
  });

  it("names a listed account ACCOUNT_ID when no account id was given", async () => {
    const listing: Fixture = {
      interactions: [
        {
          request: { method: "GET", url: "https://api.cloudflare.com/client/v4/accounts?per_page=50" },
          response: { status: 200, body: { result: [{ id: "abc" }, { id: "def" }] } },
        },
        {
          request: { method: "GET", url: "https://api.cloudflare.com/client/v4/accounts/abc/tokens/verify" },
          response: { status: 200, body: { result: { id: "tok", status: "active" } } },
        },
      ],
    };

    const fixture = sanitize(listing, []);

    expect(fixture.interactions.map((i) => i.request.url)).toEqual([
      "https://api.cloudflare.com/client/v4/accounts?per_page=50",
      "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/tokens/verify",
    ]);
    expect(fixture.interactions[0]!.response.body).toEqual({ result: [{ id: "ACCOUNT_ID" }, { id: "ACCOUNT_ID_2" }] });
  });
});

describe("fixture replay", () => {
  it("refuses a request the recording does not have", async () => {
    const replay = replayFetch({ interactions: [] });

    await expect(replay.fetch("https://api.cloudflare.com/client/v4/user")).rejects.toThrow("Unrecorded request");
  });
});

describe("recorded fixtures", () => {
  it("never call /user or /memberships (ADR 0006)", () => {
    const dir = new URL("./fixtures/", import.meta.url);
    const urls = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => (JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Fixture).interactions.map((i) => i.request.url));

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => /\/(user|memberships)(\?|$)/.test(new URL(url).pathname))).toEqual([]);
  });
});
