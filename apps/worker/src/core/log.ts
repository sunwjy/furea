// The only way the Worker writes logs (ADR 0011). Each event carries a fixed set of fields; anything else
// is dropped here, so no destination, request header or IP-derived value can reach Workers Logs.

export type RouteKind = "redirect" | "api" | "admin" | "cron";

export type LogEvent =
  | { event: "unhandled_error"; route: RouteKind; message: string; stack?: string }
  | { event: "cache_sync_failed"; slug: string }
  | { event: "cache_repair"; repaired: number; failed: number }
  | { event: "redirect_fallback_failed"; slug: string }
  | { event: "click_write_failed"; slug: string; store: "wae" | "d1" }
  | { event: "login_rate_limited"; limiter: "per_client" | "global" }
  | { event: "screening_overridden"; slug: string }
  | { event: "screening_unavailable"; slug?: string };

type EventName = LogEvent["event"];

const FIELDS: { [E in EventName]: readonly Exclude<keyof Extract<LogEvent, { event: E }>, "event">[] } = {
  unhandled_error: ["route", "message", "stack"],
  cache_sync_failed: ["slug"],
  cache_repair: ["repaired", "failed"],
  redirect_fallback_failed: ["slug"],
  click_write_failed: ["slug", "store"],
  login_rate_limited: ["limiter"],
  screening_overridden: ["slug"],
  screening_unavailable: ["slug"],
};

const FAILURES: ReadonlySet<EventName> = new Set([
  "unhandled_error",
  "cache_sync_failed",
  "redirect_fallback_failed",
  "click_write_failed",
  "screening_unavailable",
]);

export function log(entry: LogEvent): void {
  if (!Object.hasOwn(FIELDS, entry.event)) return;
  if (entry.event === "cache_repair" && entry.repaired === 0 && entry.failed === 0) return;

  const line: Record<string, unknown> = { event: entry.event };
  for (const field of FIELDS[entry.event]) {
    const value = (entry as Record<string, unknown>)[field];
    if (value !== undefined) line[field] = value;
  }
  const text = JSON.stringify(line);
  if (FAILURES.has(entry.event)) console.error(text);
  else console.warn(text);
}

export function routeKindOf(pathname: string): RouteKind {
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  return "redirect";
}
