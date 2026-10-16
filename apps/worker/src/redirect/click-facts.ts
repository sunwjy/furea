// The one place that reads a visitor's request for analytics (ADR 0005, *The no-IP guarantee*). It keeps the four
// click facts and nothing else; the recorder in core/clicks.ts only ever sees the value built here.

import type { ClickFacts, DeviceClass } from "../core/clicks.ts";

/** Obvious crawler and link-preview markers, matched case-insensitively. A label, not bot detection. */
const BOT_MARKERS = [
  "bot",
  "crawler",
  "spider",
  "facebookexternalhit",
  "whatsapp",
  "curl",
  "wget",
  "python-requests",
  "headless",
] as const;

export function clickFactsOf(request: Request, slug: string): ClickFacts {
  const cf = request.cf as { country?: unknown } | undefined;
  return {
    slug,
    country: typeof cf?.country === "string" && cf.country !== "" ? cf.country : "XX",
    referrerHost: referrerHostOf(request.headers.get("Referer")),
    deviceClass: deviceClassOf(request.headers.get("User-Agent") ?? ""),
  };
}

function referrerHostOf(referer: string | null): string {
  if (referer === null) return "direct";
  const host = URL.parse(referer)?.hostname ?? "";
  return host === "" ? "direct" : host.toLowerCase();
}

function deviceClassOf(userAgent: string): DeviceClass {
  const ua = userAgent.toLowerCase();
  if (BOT_MARKERS.some((marker) => ua.includes(marker))) return "bot";
  if (ua.includes("ipad") || ua.includes("tablet") || (ua.includes("android") && !ua.includes("mobile"))) {
    return "tablet";
  }
  if (ua.includes("mobi") || ua.includes("iphone") || ua.includes("ipod") || ua.includes("android")) return "mobile";
  if (ua.includes("windows") || ua.includes("macintosh") || ua.includes("x11") || ua.includes("cros")) {
    return "desktop";
  }
  return "unknown";
}
