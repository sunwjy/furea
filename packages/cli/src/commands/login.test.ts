import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replayFetch, useFixture } from "../../test/fixtures.ts";
import { fakeTerminal } from "../../test/terminal.ts";
import { runCli } from "../cli.ts";

const USER_TEMPLATE =
  "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" +
  "%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C" +
  "%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C" +
  "%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C" +
  "%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C" +
  "%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D" +
  "&accountId=*&zoneId=all&name=furea";

function configDir(): string {
  return mkdtempSync(join(tmpdir(), "furea-cli-"));
}

function credentialsIn(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
}

describe("login", () => {
  it("opens the user-token template, verifies a pasted user token and stores it for the account", async () => {
    const api = useFixture("login-user-token", { accountEnv: "CLOUDFLARE_ACCOUNT_ID" });
    const terminal = fakeTerminal({ interactive: true, answers: [api.token] });
    const dir = configDir();

    const code = await runCli(["login", "--account", api.accountId!], {
      fetch: api.fetch,
      env: {},
      configDir: dir,
      io: terminal,
    });

    expect(code).toBe(0);
    expect(terminal.opened).toEqual([USER_TEMPLATE]);
    expect(credentialsIn(dir)).toEqual({ accounts: { [api.accountId!]: api.token } });
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    api.done();
  });

  it("opens the account-owned form with --account-token, resolves the account and verifies a cfat_ token on the account endpoint", async () => {
    const api = useFixture("login-account-token", { tokenEnv: "FUREA_RECORD_ACCOUNT_TOKEN" });
    const terminal = fakeTerminal({ interactive: true, answers: [api.token] });
    const dir = configDir();

    const code = await runCli(["login", "--account-token"], { fetch: api.fetch, env: {}, configDir: dir, io: terminal });

    expect(code).toBe(0);
    expect(terminal.opened).toEqual([
      "https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=" +
        "%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C" +
        "%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C" +
        "%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C" +
        "%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C" +
        "%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%5D&name=furea",
    ]);
    expect(Object.values((credentialsIn(dir) as { accounts: object }).accounts)).toEqual([api.token]);
    api.done();
  });

  it("retries verification once on the other endpoint when the prefix guessed wrong", async () => {
    const api = useFixture("login-verify-fallback", { replayOnly: true });
    const terminal = fakeTerminal({ interactive: false });
    const dir = configDir();

    const code = await runCli(["login"], {
      fetch: api.fetch,
      env: { CLOUDFLARE_API_TOKEN: api.token, CLOUDFLARE_ACCOUNT_ID: api.accountId },
      configDir: dir,
      io: terminal,
    });

    expect(code).toBe(0);
    expect(terminal.opened).toEqual([]);
    expect(credentialsIn(dir)).toEqual({ accounts: { ACCOUNT_ID: api.token } });
    api.done();
  });

  it("stores nothing when both endpoints reject the token", async () => {
    const api = useFixture("login-invalid-token", { tokenEnv: "FUREA_RECORD_INVALID_TOKEN", accountEnv: "CLOUDFLARE_ACCOUNT_ID" });
    const terminal = fakeTerminal({ interactive: true, answers: [api.token] });
    const dir = configDir();

    const code = await runCli(["login", "--account", api.accountId!], { fetch: api.fetch, env: {}, configDir: dir, io: terminal });

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/Cloudflare rejected the token: .*Invalid API Token/);
    expect(() => credentialsIn(dir)).toThrow();
    api.done();
  });

  it("adds a second account next to the first", async () => {
    const api = useFixture("login-user-token", { accountEnv: "CLOUDFLARE_ACCOUNT_ID" });
    const dir = configDir();
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ accounts: { OTHER: "other-token" } }));

    const code = await runCli(["login", "--account", api.accountId!], {
      fetch: api.fetch,
      env: {},
      configDir: dir,
      io: fakeTerminal({ interactive: true, answers: [api.token] }),
    });

    expect(code).toBe(0);
    expect(credentialsIn(dir)).toEqual({ accounts: { OTHER: "other-token", [api.accountId!]: api.token } });
    api.done();
  });

  describe("without a terminal", () => {
    it("prompts for nothing and names CLOUDFLARE_API_TOKEN when no token is given", async () => {
      const terminal = fakeTerminal({ interactive: false });
      const noRequests = replayFetch({ interactions: [] });

      const code = await runCli(["login"], { fetch: noRequests.fetch, env: {}, configDir: configDir(), io: terminal });

      expect(code).toBe(1);
      expect(terminal.stderr.join("\n")).toContain("CLOUDFLARE_API_TOKEN");
      expect(terminal.opened).toEqual([]);
      noRequests.done();
    });

    it("names --account when the token sees several accounts", async () => {
      const api = useFixture("accounts-several", { replayOnly: true });
      const terminal = fakeTerminal({ interactive: false });

      const code = await runCli(["login"], {
        fetch: api.fetch,
        env: { CLOUDFLARE_API_TOKEN: api.token },
        configDir: configDir(),
        io: terminal,
      });

      expect(code).toBe(1);
      expect(terminal.stderr.join("\n")).toContain("--account");
      api.done();
    });
  });
});

describe("logout", () => {
  it("removes the named account's token and keeps the others", async () => {
    const dir = configDir();
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ accounts: { A: "token-a", B: "token-b" } }));
    const noRequests = replayFetch({ interactions: [] });

    const code = await runCli(["logout", "--account", "A"], {
      fetch: noRequests.fetch,
      env: {},
      configDir: dir,
      io: fakeTerminal({ interactive: false }),
    });

    expect(code).toBe(0);
    expect(credentialsIn(dir)).toEqual({ accounts: { B: "token-b" } });
  });

  it("removes the only stored token without --account", async () => {
    const dir = configDir();
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ accounts: { A: "token-a" } }));

    const code = await runCli(["logout"], {
      fetch: replayFetch({ interactions: [] }).fetch,
      env: {},
      configDir: dir,
      io: fakeTerminal({ interactive: false }),
    });

    expect(code).toBe(0);
    expect(() => credentialsIn(dir)).toThrow();
  });

  it("names --account when several tokens are stored and stdin is not a terminal", async () => {
    const dir = configDir();
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ accounts: { A: "token-a", B: "token-b" } }));
    const terminal = fakeTerminal({ interactive: false });

    const code = await runCli(["logout"], { fetch: replayFetch({ interactions: [] }).fetch, env: {}, configDir: dir, io: terminal });

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toContain("--account");
    expect(credentialsIn(dir)).toEqual({ accounts: { A: "token-a", B: "token-b" } });
  });
});
