import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type FixtureSecrets, useFixture } from "../../test/fixtures.ts";
import { fakeTerminal } from "../../test/terminal.ts";
import { runCli } from "../cli.ts";
import type { Clock, TailTransport } from "../tail-socket.ts";

const MESSAGES = readFileSync(new URL("../../test/fixtures/tail-messages.ndjson", import.meta.url), "utf8").trim().split("\n");

/** When the test starts; the tails in the fixtures expire six hours later. */
const NOW = Date.parse("2026-10-16T10:00:00Z");

interface FakeSocket {
  url: string;
  sent: string[];
  closed: boolean;
  deliver(message: string): void;
  /** The server side goes away. */
  drop(): void;
}

/** A `trace-v1` transport whose sockets the test drives; closing one reports the close, as a real WebSocket does. */
function fakeTransport() {
  const sockets: FakeSocket[] = [];
  const transport: TailTransport = {
    async connect(url, on) {
      const socket: FakeSocket = { url, sent: [], closed: false, deliver: on.message, drop: on.close };
      sockets.push(socket);
      return {
        send: (text) => void socket.sent.push(text),
        close: () => {
          socket.closed = true;
          on.close();
        },
      };
    },
  };
  return { transport, sockets };
}

function fakeClock() {
  const timers: Array<{ ms: number; fire(): void; cancelled: boolean }> = [];
  const clock: Clock = {
    now: () => NOW,
    setTimeout(fire, ms) {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  };
  return { clock, timers };
}

async function logs(scenario: string, argv: string[] = [], secrets: FixtureSecrets = {}) {
  const api = useFixture(scenario, { accountEnv: "CLOUDFLARE_ACCOUNT_ID", ...secrets });
  const sent: Array<{ method: string; url: string; body: unknown }> = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return api.fetch(input, init);
  }) as typeof fetch;
  const terminal = fakeTerminal({ interactive: false });
  const { transport, sockets } = fakeTransport();
  const { clock, timers } = fakeClock();
  const stop = new AbortController();
  const exit = runCli(["logs", ...argv], {
    fetch: spy,
    env: { CLOUDFLARE_API_TOKEN: api.token, CLOUDFLARE_ACCOUNT_ID: api.accountId! },
    configDir: mkdtempSync(join(tmpdir(), "furea-cli-")),
    io: terminal,
    tail: transport,
    clock,
    untilInterrupted: () => stop.signal,
  });
  const connected = (count: number) => vi.waitFor(() => expect(sockets).toHaveLength(count));
  return { exit, api, sent, terminal, sockets, timers, connected, interrupt: () => stop.abort() };
}

describe("furea logs", () => {
  it("opens a tail, prints each event, and deletes the tail on Ctrl-C", async () => {
    const run = await logs("logs-tail");
    await run.connected(1);
    for (const message of MESSAGES) run.sockets[0]!.deliver(message);
    run.interrupt();

    expect(await run.exit).toBe(0);
    run.api.done();
    expect(run.sent[0]).toMatchObject({ method: "POST", body: { filters: [] } });
    expect(run.sockets[0]).toMatchObject({ url: "wss://tail.developers.workers.dev/ID_1", sent: ['{"debug":false}'], closed: true });
    expect(run.terminal.stdout).toEqual([
      "2026-10-16T10:00:00.000Z  ok  GET /abc123",
      '2026-10-16T10:00:01.000Z  ok  POST /api/v1/links\n  warn  {"event":"cache_sync_failed","slug":"spring"}',
      expect.stringMatching(/^2026-10-16T10:00:02\.000Z {2}exception {2}GET \/admin\/links\/spring\n/),
      '2026-10-16T10:00:03.000Z  ok  cron */5 * * * *\n  warn  {"event":"cache_repair","repaired":1,"failed":0}',
      "2026-10-16T10:00:04.000Z  exceededCpu  GET /api/v1/stats/spring",
      "2026-10-16T10:00:05.000Z  ok  HEAD /spring\n  exception  Error: D1_ERROR: database is locked",
    ]);
    expect(run.terminal.stdout.join("\n")).not.toContain("203.0.113");
  });

  it("points to the dashboard for past logs, on stderr so --json output stays clean", async () => {
    const run = await logs("logs-tail");
    await run.connected(1);
    run.interrupt();

    expect(await run.exit).toBe(0);
    const stderr = run.terminal.stderr.join("\n");
    expect(stderr).toContain("nothing is stored");
    expect(stderr).toContain("Workers & Pages → furea → Observability");
  });

  it("--errors keeps only non-ok outcomes and events with exceptions", async () => {
    const run = await logs("logs-tail", ["--errors"]);
    await run.connected(1);
    for (const message of MESSAGES) run.sockets[0]!.deliver(message);
    run.interrupt();

    expect(await run.exit).toBe(0);
    expect(run.terminal.stdout.map((line) => line.split("\n")[0])).toEqual([
      "2026-10-16T10:00:02.000Z  exception  GET /admin/links/spring",
      "2026-10-16T10:00:04.000Z  exceededCpu  GET /api/v1/stats/spring",
      "2026-10-16T10:00:05.000Z  ok  HEAD /spring",
    ]);
  });

  it("--json prints one JSON object per line with the same fields", async () => {
    const run = await logs("logs-tail", ["--json", "--errors"]);
    await run.connected(1);
    for (const message of MESSAGES) run.sockets[0]!.deliver(message);
    run.interrupt();

    expect(await run.exit).toBe(0);
    expect(run.terminal.stdout.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ time: "2026-10-16T10:00:02.000Z", outcome: "exception", method: "GET", path: "/admin/links/spring" }),
      { time: "2026-10-16T10:00:04.000Z", outcome: "exceededCpu", method: "GET", path: "/api/v1/stats/spring", logs: [], exceptions: [] },
      {
        time: "2026-10-16T10:00:05.000Z",
        outcome: "ok",
        method: "HEAD",
        path: "/spring",
        logs: [],
        exceptions: [{ name: "Error", message: "D1_ERROR: database is locked" }],
      },
    ]);
  });

  it("recreates the tail at expires_at, then deletes the old one", async () => {
    const run = await logs("logs-tail-renewed");
    await run.connected(1);
    expect(run.timers.map((t) => t.ms)).toEqual([6 * 60 * 60 * 1000]);

    run.timers[0]!.fire();
    await run.connected(2);
    await vi.waitFor(() => expect(run.sent.filter((s) => s.method === "DELETE")).toHaveLength(1));
    expect(run.sockets[0]!.closed).toBe(true);
    expect(run.sockets[1]).toMatchObject({ url: "wss://tail.developers.workers.dev/ID_2", sent: ['{"debug":false}'], closed: false });
    run.sockets[1]!.deliver(MESSAGES[0]!);
    run.interrupt();

    expect(await run.exit).toBe(0);
    run.api.done();
    expect(run.terminal.stdout).toEqual(["2026-10-16T10:00:00.000Z  ok  GET /abc123"]);
    expect(run.timers.at(-1)).toMatchObject({ ms: 12 * 60 * 60 * 1000, cancelled: true });
  });

  it("deletes both tails and exits on Ctrl-C while a renewal is opening", async () => {
    const run = await logs("logs-tail-renewed");
    await run.connected(1);

    run.timers[0]!.fire();
    run.interrupt();

    expect(await run.exit).toBe(0);
    run.api.done();
    const deleted = run.sent.filter((s) => s.method === "DELETE").map((s) => s.url.split("/").at(-1));
    expect(deleted.sort()).toEqual(["ID_1", "ID_2"]);
    expect(run.sockets.map((s) => s.closed)).toEqual([true, true]);
    expect(run.timers.every((t) => t.cancelled || t === run.timers[0])).toBe(true);
  });

  it("deletes the tail and fails when the connection drops", async () => {
    const run = await logs("logs-tail");
    await run.connected(1);
    run.sockets[0]!.drop();

    expect(await run.exit).toBe(1);
    run.api.done();
    expect(run.terminal.stderr.at(-1)).toMatch(/connection closed/);
  });

  it("says so and exits when 10 viewers are already watching", async () => {
    const run = await logs("logs-viewer-limit", [], { replayOnly: true });

    expect(await run.exit).toBe(1);
    run.api.done();
    expect(run.sockets).toEqual([]);
    expect(run.terminal.stderr.at(-1)).toMatch(/10 .*viewers/);
  });

  it("names the instance when there is no Worker by that name", async () => {
    const run = await logs("logs-no-instance", [], { replayOnly: true });

    expect(await run.exit).toBe(1);
    run.api.done();
    expect(run.terminal.stderr.at(-1)).toMatch(/No instance named "furea"/);
  });
});
