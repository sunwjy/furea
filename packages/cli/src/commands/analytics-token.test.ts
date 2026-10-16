import { describe, expect, it } from "vitest";
import { runAgainst, runOffline, type Sent } from "../../test/run.ts";

const ANALYTICS = { extra: { FUREA_ANALYTICS_TOKEN: "ANALYTICS_TOKEN" } };

const USER_TEMPLATE =
  "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" +
  "%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=furea-analytics";
const ACCOUNT_TEMPLATE =
  "https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=" +
  "%5B%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%5D&name=furea-analytics";

function secretsPut(sent: Sent[]): unknown[] {
  return sent.filter((s) => s.method === "PUT" && s.url.endsWith("/secrets")).map((s) => JSON.parse(String(s.init!.body)));
}

describe("analytics-token", () => {
  it("verifies FUREA_ANALYTICS_TOKEN and stores it as the ANALYTICS_TOKEN secret", async () => {
    const { code, terminal, sent, api } = await runAgainst("analytics-token", ["analytics-token"], { secrets: ANALYTICS });

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(secretsPut(sent)).toEqual([{ name: "ANALYTICS_TOKEN", text: api.extra.FUREA_ANALYTICS_TOKEN, type: "secret_text" }]);
    expect(terminal.stdout.join("\n")).toMatch(/Stored the analytics token as the ANALYTICS_TOKEN secret\./);
    expect(terminal.opened).toEqual([]);
    api.done();
  });

  it("says when it replaces a stored token", async () => {
    const { code, terminal, api } = await runAgainst("analytics-token-replace", ["analytics-token"], { secrets: ANALYTICS });

    expect(code).toBe(0);
    expect(terminal.stdout.join("\n")).toMatch(/replacing the previous one/);
    api.done();
  });

  it("opens the read-only user-token template at a terminal and stores the pasted token", async () => {
    const { code, terminal, sent, api } = await runAgainst("analytics-token", ["analytics-token"], {
      interactive: true,
      answers: ["ANALYTICS_TOKEN"],
    });

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.opened).toEqual([USER_TEMPLATE]);
    expect(secretsPut(sent)).toHaveLength(1);
    api.done();
  });

  it("opens the account-owned form with --account-token and verifies a cfat_ token on the account endpoint", async () => {
    const { code, terminal, api } = await runAgainst("analytics-token-account-owned", ["analytics-token", "--account-token"], {
      interactive: true,
      answers: ["cfat_ANALYTICS_TOKEN"],
    });

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.opened).toEqual([ACCOUNT_TEMPLATE]);
    api.done();
  });

  it("still stores the token without the CLICKS binding, warning that breakdowns stay empty", async () => {
    const { code, terminal, sent, api } = await runAgainst("analytics-token-no-clicks", ["analytics-token"], { secrets: ANALYTICS });

    expect(code).toBe(0);
    expect(secretsPut(sent)).toHaveLength(1);
    expect(terminal.stdout.join("\n")).toMatch(
      /no CLICKS binding.*breakdowns stay empty.*https:\/\/github\.com\/sunwjy\/furea\/blob\/main\/docs\/analytics-engine\.md/s,
    );
    api.done();
  });

  it("stores nothing when Cloudflare rejects the analytics token on both verify endpoints", async () => {
    const { code, terminal, sent, api } = await runAgainst("analytics-token-rejected", ["analytics-token"], { secrets: ANALYTICS });

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/Cloudflare rejected the analytics token: .*Invalid API Token/);
    expect(secretsPut(sent)).toEqual([]);
    api.done();
  });

  it("refuses when there is no instance of that name", async () => {
    const { code, terminal, api } = await runAgainst("analytics-token-no-instance", ["analytics-token"], { secrets: ANALYTICS });

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/No furea instance named "furea"/);
    api.done();
  });

  it("names FUREA_ANALYTICS_TOKEN when it cannot ask", async () => {
    const { code, terminal } = await runOffline(["analytics-token"]);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/FUREA_ANALYTICS_TOKEN/);
    expect(terminal.opened).toEqual([]);
  });
});
