// Time buckets in the browser's time zone (ADR 0005): the same boundaries `toStartOfInterval(timestamp, INTERVAL ...,
// tz)` gives Analytics Engine, generated here so the series can be zero-filled and labelled with the zone's offset.

import type { StatsRange } from "@furea/shared";

const HOUR_MS = 3_600_000;

export interface Bucket {
  /** As the SQL API prints the bucket: the zone's wall-clock time, `YYYY-MM-DD HH:MM:SS`. */
  key: string;
  /** ISO 8601 with the zone's offset, `Z` for UTC: the `start` of a series point. */
  start: string;
  startMs: number;
  endMs: number;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(tz: string, ms: number): WallClock {
  let formatter = formatters.get(tz);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return {
    year: parts["year"] ?? 0,
    month: parts["month"] ?? 0,
    day: parts["day"] ?? 0,
    hour: parts["hour"] ?? 0,
    minute: parts["minute"] ?? 0,
    second: parts["second"] ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetMs(tz: string, ms: number): number {
  const w = wallClock(tz, ms);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant the zone's calendar day `year-month-day` starts. */
function startOfDay(tz: string, year: number, month: number, day: number): number {
  const asUtc = Date.UTC(year, month - 1, day);
  const guess = asUtc - offsetMs(tz, asUtc);
  return asUtc - offsetMs(tz, guess);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function wallKey(w: WallClock): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

function isoWithOffset(tz: string, ms: number): string {
  const offset = Math.round(offsetMs(tz, ms) / 60_000);
  const abs = Math.abs(offset);
  const zone = offset === 0 ? "Z" : `${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${wallKey(wallClock(tz, ms)).replace(" ", "T")}${zone}`;
}

function bucket(tz: string, startMs: number, endMs: number): Bucket {
  return { key: wallKey(wallClock(tz, startMs)), start: isoWithOffset(tz, startMs), startMs, endMs };
}

/** The last `days` calendar days in the zone, today included, oldest first. */
export function dailyBuckets(tz: string, days: number, now: Date): Bucket[] {
  const today = wallClock(tz, now.getTime());
  const dayStart = (offset: number) => {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    return startOfDay(tz, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  };
  return Array.from({ length: days }, (_, i) => {
    const offset = i - (days - 1);
    return bucket(tz, dayStart(offset), dayStart(offset + 1));
  });
}

/** The last 24 hours in the zone, the current one included, oldest first. */
export function hourlyBuckets(tz: string, now: Date): Bucket[] {
  const w = wallClock(tz, now.getTime());
  const current = now.getTime() - (w.minute * 60 + w.second) * 1000 - now.getUTCMilliseconds();
  return Array.from({ length: 24 }, (_, i) => {
    const start = current - (23 - i) * HOUR_MS;
    return bucket(tz, start, start + HOUR_MS);
  });
}

const RANGE_DAYS: Record<Exclude<StatsRange, "24h">, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function rangeBuckets(range: StatsRange, tz: string, now: Date): Bucket[] {
  return range === "24h" ? hourlyBuckets(tz, now) : dailyBuckets(tz, RANGE_DAYS[range], now);
}

/** `toStartOfInterval`'s interval for the range's buckets. */
export const rangeInterval = (range: StatsRange) => (range === "24h" ? "INTERVAL '1' HOUR" : "INTERVAL '1' DAY");

/** `toDateTime('YYYY-MM-DD HH:MM:SS')` in UTC, the form the SQL API was smoke-tested with (#34). */
export function sqlDateTime(ms: number): string {
  return `toDateTime('${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}')`;
}
