// Runs one CLI invocation against a fixture: the env carries the fixture's token and account id, every request is
// captured, and `done()` (asserting the whole recording was replayed) is left to the test.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { type FixtureSecrets, replayFetch, useFixture } from "./fixtures.ts";
import { fakeTerminal } from "./terminal.ts";

export interface Sent {
  method: string;
  url: string;
  init: RequestInit | undefined;
}

export interface FixtureRun {
  interactive?: boolean;
  answers?: string[];
  env?: Record<string, string>;
  secrets?: FixtureSecrets;
  /** A config directory prepared by the test; a fresh empty one otherwise. */
  configDir?: string;
}

export async function runAgainst(scenario: string, argv: string[], run: FixtureRun = {}) {
  const api = useFixture(scenario, { accountEnv: "CLOUDFLARE_ACCOUNT_ID", ...run.secrets });
  const sent: Sent[] = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", url: String(input), init });
    return api.fetch(input, init);
  }) as typeof fetch;
  const terminal = fakeTerminal({ interactive: run.interactive ?? false, answers: run.answers ?? [] });
  const env = { CLOUDFLARE_API_TOKEN: api.token, CLOUDFLARE_ACCOUNT_ID: api.accountId!, ...api.extra, ...run.env };
  const configDir = run.configDir ?? mkdtempSync(join(tmpdir(), "furea-cli-"));
  const code = await runCli(argv, { fetch: spy, env, configDir, io: terminal });
  return { code, terminal, sent, api };
}

/** A run that must fail before calling Cloudflare: any request fails the replay. */
export async function runOffline(argv: string[], run: Omit<FixtureRun, "secrets"> = {}) {
  const replay = replayFetch({ interactions: [] });
  const terminal = fakeTerminal({ interactive: run.interactive ?? false, answers: run.answers ?? [] });
  const env = { CLOUDFLARE_API_TOKEN: "TOKEN", CLOUDFLARE_ACCOUNT_ID: "ACCOUNT_ID", ...run.env };
  const code = await runCli(argv, { fetch: replay.fetch, env, configDir: mkdtempSync(join(tmpdir(), "furea-cli-")), io: terminal });
  return { code, terminal };
}

/** The JSON bodies of the D1 `/query` requests, in order. */
export function d1Queries(sent: Sent[]): Array<{ sql: string; params?: unknown[] }> {
  return sent.filter((s) => s.url.endsWith("/query")).map((s) => JSON.parse(String(s.init!.body)) as { sql: string; params?: unknown[] });
}
