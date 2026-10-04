import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { log, routeKindOf, type LogEvent } from "./log.ts";

let error: MockInstance<typeof console.error>;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function written(): unknown[] {
  return [...error.mock.calls, ...warn.mock.calls].map(([line]) => JSON.parse(String(line)));
}

describe("log", () => {
  it.each<[LogEvent, "error" | "warn"]>([
    [{ event: "unhandled_error", route: "redirect", message: "boom", stack: "Error: boom\n  at x" }, "error"],
    [{ event: "cache_sync_failed", slug: "abc" }, "error"],
    [{ event: "cache_repair", repaired: 2, failed: 1 }, "warn"],
    [{ event: "redirect_fallback_failed", slug: "abc" }, "error"],
    [{ event: "click_write_failed", slug: "abc", store: "wae" }, "error"],
    [{ event: "login_rate_limited", limiter: "per_client" }, "warn"],
    [{ event: "screening_overridden", slug: "_" }, "warn"],
    [{ event: "screening_unavailable", slug: "abc" }, "error"],
    [{ event: "screening_unavailable" }, "error"],
  ])("writes %j as one JSON line", (event, level) => {
    log(event);
    const spy = level === "error" ? error : warn;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual(event);
    expect(written()).toHaveLength(1);
  });

  it("drops fields that ADR 0011 does not allow for the event", () => {
    const smuggled = {
      event: "cache_sync_failed",
      slug: "abc",
      destination: "https://example.com/?token=secret",
      ip: "203.0.113.7",
      headers: { "user-agent": "x" },
    } as unknown as LogEvent;
    log(smuggled);
    expect(written()).toEqual([{ event: "cache_sync_failed", slug: "abc" }]);
  });

  it("writes nothing for an event name outside ADR 0011", () => {
    log({ event: "redirect", slug: "abc" } as unknown as LogEvent);
    expect(written()).toEqual([]);
  });

  it("does not write a cache_repair pass that had nothing to do", () => {
    log({ event: "cache_repair", repaired: 0, failed: 0 });
    expect(written()).toEqual([]);
  });
});

describe("routeKindOf", () => {
  it.each([
    ["/", "redirect"],
    ["/abc", "redirect"],
    ["/robots.txt", "redirect"],
    ["/api", "api"],
    ["/api/v1/links", "api"],
    ["/admin", "admin"],
    ["/admin/links", "admin"],
    ["/apiary", "redirect"],
    ["/administrator", "redirect"],
  ] as const)("%s is a %s route", (path, kind) => {
    expect(routeKindOf(path)).toBe(kind);
  });
});
