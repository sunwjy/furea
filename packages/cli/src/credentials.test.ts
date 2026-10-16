import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replayFetch } from "../test/fixtures.ts";
import { fakeTerminal } from "../test/terminal.ts";
import type { CommandContext } from "./context.ts";
import { CredentialsFile, resolveDeployCredentials } from "./credentials.ts";

function context(options: { stored?: Record<string, string>; env?: Record<string, string>; account?: string }): CommandContext {
  const dir = mkdtempSync(join(tmpdir(), "furea-cli-"));
  if (options.stored) writeFileSync(join(dir, "credentials.json"), JSON.stringify({ accounts: options.stored }));
  return {
    fetch: replayFetch({ interactions: [] }).fetch,
    env: options.env ?? {},
    io: fakeTerminal({ interactive: false }),
    credentials: new CredentialsFile(dir),
    name: "furea",
    account: options.account,
  };
}

describe("resolveDeployCredentials", () => {
  it("uses CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID without reading the file", async () => {
    const ctx = context({
      stored: { A: "stored-token" },
      env: { CLOUDFLARE_API_TOKEN: "env-token", CLOUDFLARE_ACCOUNT_ID: "B" },
    });

    expect(await resolveDeployCredentials(ctx)).toEqual({ token: "env-token", accountId: "B" });
  });

  it("picks the single stored account automatically", async () => {
    expect(await resolveDeployCredentials(context({ stored: { A: "token-a" } }))).toEqual({ token: "token-a", accountId: "A" });
  });

  it("picks the --account entry among several", async () => {
    const ctx = context({ stored: { A: "token-a", B: "token-b" }, account: "B" });

    expect(await resolveDeployCredentials(ctx)).toEqual({ token: "token-b", accountId: "B" });
  });

  it("names --account when several are stored and stdin is not a terminal", async () => {
    await expect(resolveDeployCredentials(context({ stored: { A: "a", B: "b" } }))).rejects.toThrow("--account");
  });

  it("points at login when nothing is stored", async () => {
    await expect(resolveDeployCredentials(context({}))).rejects.toThrow(/furea login.*CLOUDFLARE_API_TOKEN/);
  });

  it("refuses an --account that has no stored token", async () => {
    await expect(resolveDeployCredentials(context({ stored: { A: "a" }, account: "Z" }))).rejects.toThrow(/account Z/);
  });
});
