import { describe, expect, it } from "vitest";
import { d1Queries, runAgainst, runOffline } from "../../test/run.ts";

const ENABLE = ["access", "enable", "--team-domain", "https://MyTeam.cloudflareaccess.com/", "--aud", "AUD_TAG_1"];

describe("access enable", () => {
  it("checks the own domain and the team's keys, then writes both settings and signs out every password session", async () => {
    const { code, terminal, sent, api } = await runAgainst("access-enable", ENABLE);

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(d1Queries(sent)).toEqual([
      {
        sql:
          "INSERT INTO settings (key, value) VALUES ('access_team_domain', ?), ('access_aud', ?) " +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params: ["myteam.cloudflareaccess.com", "AUD_TAG_1"],
      },
      { sql: "DELETE FROM sessions" },
    ]);
    expect(terminal.stdout.join("\n")).toMatch(/Access mode is on for https:\/\/host-2\.example\.com/);
    api.done();
  });

  it("asks for the team domain and AUD at a terminal", async () => {
    const { code, terminal, api } = await runAgainst("access-enable", ["access", "enable"], {
      interactive: true,
      answers: ["myteam.cloudflareaccess.com", "AUD_TAG_1"],
    });

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.questions).toHaveLength(2);
    api.done();
  });

  it("is refused on a workers.dev-only instance, writing nothing", async () => {
    const { code, terminal, sent, api } = await runAgainst("access-enable-workers-dev", ENABLE);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/own domain.*npx furea domain set/s);
    expect(d1Queries(sent)).toEqual([]);
    api.done();
  });

  it("is refused when the team's public keys cannot be fetched", async () => {
    const { code, terminal, sent, api } = await runAgainst("access-enable-unreachable", ENABLE);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/Could not fetch the public keys of myteam\.cloudflareaccess\.com/);
    expect(d1Queries(sent)).toEqual([]);
    api.done();
  });

  it("rejects a team domain outside cloudflareaccess.com before calling Cloudflare", async () => {
    const { code, terminal } = await runOffline(["access", "enable", "--team-domain", "example.com", "--aud", "x"]);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/myteam\.cloudflareaccess\.com/);
  });

  it("names the flags when it cannot ask", async () => {
    const { code, terminal } = await runOffline(["access", "enable"]);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/--team-domain/);
  });
});

describe("access disable", () => {
  it("removes both settings, from any hostname", async () => {
    const { code, terminal, sent, api } = await runAgainst("access-disable", ["access", "disable"]);

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(d1Queries(sent)).toEqual([{ sql: "DELETE FROM settings WHERE key IN ('access_team_domain', 'access_aud')" }]);
    expect(terminal.stdout.join("\n")).toMatch(/Access mode is off/);
    api.done();
  });
});
