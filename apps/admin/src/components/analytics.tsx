// Click breakdown widgets (ADR 0005): tiles, sparklines, the bar series and top lists, every WAE-derived number
// labelled as a last-90-days estimate, plus the degraded-mode hint naming what is missing.

import { STATS_RANGES, type SeriesPoint, type StatsRange } from "@furea/shared";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { AnalyticsMissing } from "@/lib/stats";

export const ESTIMATE_LABEL = "Last 90 days, estimated";

const CAUSES: Record<AnalyticsMissing, { name: string; fix: string }> = {
  binding: {
    name: "no Analytics Engine binding",
    fix: "Analytics Engine is not enabled on this Cloudflare account; enable it, then run npx furea deploy again.",
  },
  token: {
    name: "no analytics token",
    fix: "Add a read-only analytics token with npx furea analytics-token.",
  },
};

const DISMISS_KEY = "furea.analyticsHintDismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Shown instead of tiles, sparklines and breakdowns when the instance answers 503 analytics_unavailable. Dismissing
 * it is remembered in this browser until the cause changes.
 */
export function AnalyticsHint({ missing, dismissible = true }: { missing: AnalyticsMissing[]; dismissible?: boolean }) {
  const key = missing.join("+");
  const [dismissed, setDismissed] = useState(() => readDismissed() === key);
  if (dismissible && dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, key);
    } catch {
      // Remembered for this page view only.
    }
  }

  return (
    <Card size="sm" role="note" aria-label="Estimates unavailable">
      <CardContent className="flex items-start gap-3">
        <div className="flex flex-1 flex-col gap-1 text-sm">
          <p className="font-medium">
            Estimates unavailable: {missing.map((m) => CAUSES[m].name).join(" and ")}.
          </p>
          {missing.map((m) => (
            <p key={m} className="text-muted-foreground">
              {CAUSES[m].fix}
            </p>
          ))}
          <p className="text-muted-foreground">Lifetime totals still count every click.</p>
        </div>
        {dismissible ? (
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
            <X />
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

const number = (n: number) => Math.round(n).toLocaleString();

export function Tiles({ tiles }: { tiles: { label: string; value: number; hint?: string }[] }) {
  return (
    <dl aria-label="Overview" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label} size="sm">
          <CardContent className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{tile.label}</dt>
            <dd className="text-xl font-semibold tabular-nums" title={tile.hint}>
              {number(tile.value)}
            </dd>
          </CardContent>
        </Card>
      ))}
    </dl>
  );
}

/** A 7-day sparkline for a feed card. */
export function Sparkline({ points }: { points: SeriesPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.clicks));
  const total = points.reduce((sum, p) => sum + p.clicks, 0);
  const width = 4;
  const gap = 2;
  return (
    <svg
      role="img"
      aria-label={`${number(total)} clicks in 7 days, estimated`}
      width={points.length * (width + gap)}
      height={20}
      className="text-primary"
    >
      <title>{`${number(total)} clicks in 7 days (${ESTIMATE_LABEL.toLowerCase()})`}</title>
      {points.map((p, i) => {
        const h = Math.max(1, (p.clicks / max) * 20);
        return <rect key={p.start} x={i * (width + gap)} y={20 - h} width={width} height={h} rx={1} fill="currentColor" opacity={p.clicks === 0 ? 0.25 : 1} />;
      })}
    </svg>
  );
}

function bucketLabel(start: string, range: StatsRange): string {
  // `start` carries the requested zone's offset; its wall-clock part is what the operator reads.
  const [date = "", time = ""] = start.split("T");
  return range === "24h" ? time.slice(0, 5) : date.slice(5);
}

/** The range's series as bars, one per bucket. */
export function BarSeries({ points, range }: { points: SeriesPoint[]; range: StatsRange }) {
  const max = Math.max(1, ...points.map((p) => p.clicks));
  return (
    <ol aria-label="Clicks over time" className="flex h-32 items-end gap-px">
      {points.map((p) => (
        <li
          key={p.start}
          className="flex h-full flex-1 items-end"
          title={`${bucketLabel(p.start, range)}: ${number(p.clicks)} clicks`}
          aria-label={`${bucketLabel(p.start, range)}: ${number(p.clicks)} clicks`}
        >
          <div
            className={p.clicks === 0 ? "w-full bg-muted" : "w-full rounded-t-sm bg-primary"}
            style={{ height: `${Math.max(2, (p.clicks / max) * 100)}%` }}
          />
        </li>
      ))}
    </ol>
  );
}

export const RANGE_LABELS: Record<StatsRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

export function RangeTabs({ range, onChange }: { range: StatsRange; onChange: (range: StatsRange) => void }) {
  return (
    <div role="tablist" aria-label="Range" className="flex gap-1">
      {STATS_RANGES.map((r) => (
        <Button
          key={r}
          role="tab"
          aria-selected={r === range}
          variant={r === range ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onChange(r)}
        >
          {RANGE_LABELS[r]}
        </Button>
      ))}
    </div>
  );
}

/** A row's share of the busiest row, for comparing rows of a table; decorative, the number sits next to it. */
export function ComparisonBar({ value, max }: { value: number; max: number }) {
  return (
    <span aria-hidden className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-muted align-middle">
      <span className="block h-full rounded-full bg-primary" style={{ width: `${(value / Math.max(1, max)) * 100}%` }} />
    </span>
  );
}

export function TopList({ title, rows }: { title: string; rows: { label: string; clicks: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.clicks));
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No clicks in this range.</p>
      ) : (
        <ol className="flex flex-col gap-1 text-sm">
          {rows.map((r) => (
            <li key={r.label} className="relative flex justify-between gap-2 px-2 py-0.5">
              <span className="absolute inset-y-0 left-0 rounded-sm bg-muted" style={{ width: `${(r.clicks / max) * 100}%` }} />
              <span className="relative truncate">{r.label}</span>
              <span className="relative tabular-nums">{number(r.clicks)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
