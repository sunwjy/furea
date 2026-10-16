import { beforeAll, describe, expect, it, vi } from "vitest";
import { certsFetch, createTestTeam, type TestTeam } from "./access.fixture.ts";
import { createAccessVerifier } from "./access.ts";

let team: TestTeam;
let other: TestTeam;

beforeAll(async () => {
  team = await createTestTeam("core-team.cloudflareaccess.com");
  other = await createTestTeam("core-other.cloudflareaccess.com");
});

const config = () => ({ teamDomain: team.teamDomain, aud: team.aud });

describe("verify", () => {
  it("accepts a JWT signed by the team's key for this application", async () => {
    const verifier = createAccessVerifier({ fetch: certsFetch(team) });
    expect(await verifier.verify(await team.sign(), config())).toEqual({ email: "operator@example.com" });
  });

  it("refuses a JWT for another application, another team, or past its expiry", async () => {
    const verifier = createAccessVerifier({ fetch: certsFetch(team, other) });
    const now = Math.floor(Date.now() / 1000);
    const refused = [
      await team.sign({ aud: ["someone-elses-aud"] }),
      await team.sign({ iss: `https://${other.teamDomain}` }),
      await other.sign({ aud: [team.aud], iss: `https://${team.teamDomain}` }),
      await team.sign({ exp: now - 120 }),
      await team.sign({ nbf: now + 600 }),
      await team.sign({}, { alg: "none" }),
      (await team.sign()).replace(/\.[^.]+$/, ".AAAA"),
      "not.a.jwt",
      "",
    ];
    for (const token of refused) expect(await verifier.verify(token, config())).toBeNull();
  });

  it("accepts aud as a plain string", async () => {
    const verifier = createAccessVerifier({ fetch: certsFetch(team) });
    expect(await verifier.verify(await team.sign({ aud: team.aud }), config())).not.toBeNull();
  });

  it("fetches the keys once and reuses them", async () => {
    const fetch = vi.fn(certsFetch(team));
    const verifier = createAccessVerifier({ fetch });
    for (let i = 0; i < 3; i++) expect(await verifier.verify(await team.sign(), config())).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://core-team.cloudflareaccess.com/cdn-cgi/access/certs");
  });

  it("refetches for an unknown key id after a rotation, but not for every forged one", async () => {
    let clock = Date.now();
    const rotated = await createTestTeam(team.teamDomain, "test-key-2");
    let serving: TestTeam = team;
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => certsFetch(serving)(input, init));
    const verifier = createAccessVerifier({ fetch, now: () => clock });
    expect(await verifier.verify(await team.sign(), config())).not.toBeNull();

    serving = rotated;
    const fresh = await rotated.sign({ aud: [team.aud] });
    expect(await verifier.verify(fresh, config())).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    clock += 31_000;
    expect(await verifier.verify(fresh, config())).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses every token while the keys cannot be fetched", async () => {
    const verifier = createAccessVerifier({ fetch: async () => new Response("down", { status: 502 }) });
    expect(await verifier.verify(await team.sign(), config())).toBeNull();
  });
});

describe("keysReachable", () => {
  it("is true when the certs document holds a key and false otherwise", async () => {
    expect(await createAccessVerifier({ fetch: certsFetch(team) }).keysReachable(team.teamDomain)).toBe(true);
    expect(await createAccessVerifier({ fetch: certsFetch(team) }).keysReachable(other.teamDomain)).toBe(false);
    const empty = createAccessVerifier({ fetch: async () => Response.json({ keys: [] }) });
    expect(await empty.keysReachable(team.teamDomain)).toBe(false);
    const html = createAccessVerifier({ fetch: async () => new Response("<html>") });
    expect(await html.keysReachable(team.teamDomain)).toBe(false);
    const offline = createAccessVerifier({
      fetch: async () => {
        throw new TypeError("network down");
      },
    });
    expect(await offline.keysReachable(team.teamDomain)).toBe(false);
  });
});
