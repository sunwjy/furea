import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatLine, isError, toLogLine } from "./tail.ts";

// Trace events as the `trace-v1` WebSocket delivers them, one JSON message per line.
const MESSAGES = readFileSync(new URL("../test/fixtures/tail-messages.ndjson", import.meta.url), "utf8").trim().split("\n");
const lines = MESSAGES.map((message) => toLogLine(message)!);

describe("toLogLine", () => {
  it("keeps the time, outcome, method and the path without its query string", () => {
    expect(lines[0]).toEqual({ time: "2026-10-16T10:00:00.000Z", outcome: "ok", method: "GET", path: "/abc123", logs: [], exceptions: [] });
  });

  it("keeps the Worker's own log lines and exceptions", () => {
    expect(lines[1]!.logs).toEqual([{ level: "warn", message: '{"event":"cache_sync_failed","slug":"spring"}' }]);
    expect(lines[2]).toEqual({
      time: "2026-10-16T10:00:02.000Z",
      outcome: "exception",
      method: "GET",
      path: "/admin/links/spring",
      logs: [{ level: "error", message: `{"event":"unhandled_error","route":"admin","message":"Cannot read properties of undefined (reading 'slug')"}` }],
      exceptions: [{ name: "TypeError", message: "Cannot read properties of undefined (reading 'slug')" }],
    });
  });

  it("shows a cron event by its schedule", () => {
    expect(lines[3]).toEqual({
      time: "2026-10-16T10:00:03.000Z",
      outcome: "ok",
      cron: "*/5 * * * *",
      logs: [{ level: "warn", message: '{"event":"cache_repair","repaired":1,"failed":0}' }],
      exceptions: [],
    });
  });

  it("drops request headers, the client IP, cf fields, the host and the query before anything is printed", () => {
    for (const line of lines) {
      const text = JSON.stringify(line) + formatLine(line);
      for (const leak of ["203.0.113", "cf-connecting-ip", "Mozilla", "referer", "KR", "Seoul", "ICN", "64496", "utm_source", "visitor", "workers.dev", "REDACTED"]) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it("ignores a message that is not a trace event", () => {
    expect(toLogLine("not json")).toBeUndefined();
    expect(toLogLine('{"hello":1}')).toBeUndefined();
  });
});

describe("isError", () => {
  it("keeps non-ok outcomes and events that carry an exception", () => {
    expect(lines.map(isError)).toEqual([false, false, true, false, true, true]);
  });
});

describe("formatLine", () => {
  it("prints one line per event, with its log lines and exceptions indented below", () => {
    expect(formatLine(lines[0]!)).toBe("2026-10-16T10:00:00.000Z  ok  GET /abc123");
    expect(formatLine(lines[2]!)).toBe(
      [
        "2026-10-16T10:00:02.000Z  exception  GET /admin/links/spring",
        `  error  {"event":"unhandled_error","route":"admin","message":"Cannot read properties of undefined (reading 'slug')"}`,
        "  exception  TypeError: Cannot read properties of undefined (reading 'slug')",
      ].join("\n"),
    );
    expect(formatLine(lines[3]!)).toBe(
      ['2026-10-16T10:00:03.000Z  ok  cron */5 * * * *', '  warn  {"event":"cache_repair","repaired":1,"failed":0}'].join("\n"),
    );
  });
});
