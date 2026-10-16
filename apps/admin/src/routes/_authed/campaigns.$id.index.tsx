import {
  CAMPAIGN_LINK_LIMIT,
  groupByFoldKey,
  type Campaign,
  type CampaignStats,
  type FoldGroup,
  type Link as LinkResource,
  type StatsRange,
} from "@furea/shared";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AnalyticsHint,
  BarSeries,
  ComparisonBar,
  ESTIMATE_LABEL,
  RANGE_LABELS,
  RangeTabs,
  Tiles,
  TopList,
} from "@/components/analytics";
import { LinkBadges } from "@/components/link-status";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { CAMPAIGNS_KEY, campaignLinksQuery, campaignQuery, deleteCampaign } from "@/lib/campaigns";
import { LINKS_KEY } from "@/lib/links";
import { analyticsMissing, browserTimeZone, campaignStatsQuery } from "@/lib/stats";

export const Route = createFileRoute("/_authed/campaigns/$id/")({
  component: CampaignPage,
});

function CampaignPage() {
  const { id } = Route.useParams();
  const campaign = useQuery(campaignQuery(id));

  return (
    <div className="flex flex-col gap-6">
      <Link to="/campaigns" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Campaigns
      </Link>
      {campaign.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : campaign.isError ? (
        <p className="text-sm text-destructive">
          {campaign.error instanceof ApiError && campaign.error.status === 404
            ? "There is no such campaign."
            : "Could not load the campaign."}
        </p>
      ) : (
        <>
          <CampaignHeader campaign={campaign.data} />
          <CampaignBody campaign={campaign.data} />
        </>
      )}
    </div>
  );
}

function CampaignHeader({ campaign }: { campaign: Campaign }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteCampaign(campaign.id),
    onSuccess: async () => {
      setConfirming(false);
      toast.success(`Deleted ${campaign.name}; its links stay as plain links.`);
      await navigate({ to: "/campaigns" });
      await queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      await queryClient.invalidateQueries({ queryKey: LINKS_KEY });
    },
    onError: () => toast.error(`Could not delete ${campaign.name}. Try again.`),
  });
  const full = campaign.linkCount >= CAMPAIGN_LINK_LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-heading text-xl font-semibold">{campaign.name}</h1>
        {campaign.syncPendingLinkCount > 0 ? (
          <Badge variant="outline">{campaign.syncPendingLinkCount} sync pending</Badge>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Base URL</dt>
        <dd className="break-all">{campaign.baseUrl}</dd>
        <dt className="text-muted-foreground">UTM campaign</dt>
        <dd>
          <code>{campaign.utmCampaign}</code>
        </dd>
        <dt className="text-muted-foreground">Campaign ID</dt>
        <dd>{campaign.utmId === null ? <span className="text-muted-foreground">None</span> : <code>{campaign.utmId}</code>}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        {full ? (
          <Button size="sm" disabled>
            <Plus data-icon="inline-start" />
            Add links
          </Button>
        ) : (
          <Link to="/campaigns/$id/add" params={{ id: campaign.id }} className={buttonVariants({ size: "sm" })}>
            <Plus data-icon="inline-start" />
            Add links
          </Link>
        )}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setConfirming(true)}>
          <Trash2 data-icon="inline-start" />
          Delete campaign
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {campaign.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {campaign.linkCount === 1 ? "link stays" : `${campaign.linkCount} links stay`} as plain links, with
              the same destinations and click history; nothing is disabled or deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Delete campaign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const NONE = <span className="text-muted-foreground">—</span>;

/**
 * The campaign's numbers (ADR 0005, *Campaigns*): tiles, the comparison table and the combined breakdowns, over the
 * links that belong to it now. Without breakdowns the lifetime total and the comparison on lifetime totals stay.
 */
function CampaignBody({ campaign }: { campaign: Campaign }) {
  const [range, setRange] = useState<StatsRange>("7d");
  const stats = useQuery(campaignStatsQuery(campaign.id, range));
  const missing = stats.isError ? analyticsMissing(stats.error) : null;
  const rangeClicks = stats.data?.series.reduce((sum, p) => sum + p.clicks, 0);

  return (
    <>
      <Tiles
        tiles={[
          { label: "Lifetime total", value: campaign.clickCount, hint: "Exact: every click of the current links" },
          ...(missing === null && rangeClicks !== undefined
            ? [{ label: `Last ${RANGE_LABELS[range]}`, value: rangeClicks, hint: ESTIMATE_LABEL }]
            : []),
          { label: `Links (of ${CAMPAIGN_LINK_LIMIT})`, value: campaign.linkCount },
          { label: "Enabled links", value: campaign.enabledLinkCount },
        ]}
      />
      {missing === null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {ESTIMATE_LABEL}, in {browserTimeZone()} {range === "24h" ? "hours" : "days"}.
          </p>
          <RangeTabs range={range} onChange={setRange} />
        </div>
      ) : (
        <AnalyticsHint missing={missing} dismissible={false} />
      )}
      <CampaignLinksTable campaign={campaign} analytics={missing === null} stats={stats.data} range={range} />
      {missing === null ? <CampaignBreakdowns stats={stats} range={range} /> : null}
    </>
  );
}

function CampaignBreakdowns({ stats, range }: { stats: UseQueryResult<CampaignStats, unknown>; range: StatsRange }) {
  return (
    <section aria-label="Clicks" className="flex flex-col gap-4">
      <h2 className="font-heading text-base font-semibold">Clicks, all links</h2>
      {stats.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : stats.isError ? (
        <p className="text-sm text-destructive">Could not load the click breakdowns.</p>
      ) : (
        <>
          <BarSeries points={stats.data.series} range={range} />
          <div className="grid gap-4 sm:grid-cols-3">
            <TopList title="Countries" rows={stats.data.countries.map((r) => ({ label: r.country, clicks: r.clicks }))} />
            <TopList title="Referrers" rows={stats.data.referrerHosts.map((r) => ({ label: r.host, clicks: r.clicks }))} />
            <TopList
              title="Devices"
              rows={stats.data.deviceClasses.map((r) => ({ label: r.deviceClass, clicks: r.clicks }))}
            />
          </div>
        </>
      )}
    </section>
  );
}

type Fold = "link" | "source" | "medium";
const FOLDS: Record<Fold, string> = { link: "By link", source: "By source", medium: "By medium" };

/**
 * One row per link, or folded into one per source or medium (case-insensitively, the links' current UTM values) from
 * the rows already loaded: no extra request. With breakdowns the rows compare range clicks, otherwise lifetime totals.
 */
function CampaignLinksTable({
  campaign,
  analytics,
  stats,
  range,
}: {
  campaign: Campaign;
  analytics: boolean;
  stats: CampaignStats | undefined;
  range: StatsRange;
}) {
  const links = useQuery(campaignLinksQuery(campaign.id));
  const [fold, setFold] = useState<Fold>("link");
  const inRange = (link: LinkResource) => stats?.bySlug[link.slug]?.clicks ?? 0;
  const compared = (link: LinkResource) => (analytics ? inRange(link) : link.clickCount);
  const rangeHeader = `Last ${RANGE_LABELS[range]}`;
  const rangeCell = (value: number, max: number) => (
    <td className="px-3 py-2 text-right tabular-nums">
      {stats === undefined ? (
        "…"
      ) : (
        <span className="inline-flex items-center gap-2">
          <ComparisonBar value={value} max={max} />
          {value.toLocaleString()}
        </span>
      )}
    </td>
  );
  const lifetimeCell = (value: number, max: number) => (
    <td className="px-3 py-2 text-right tabular-nums">
      {analytics ? (
        value.toLocaleString()
      ) : (
        <span className="inline-flex items-center gap-2">
          <ComparisonBar value={value} max={max} />
          {value.toLocaleString()}
        </span>
      )}
    </td>
  );

  return (
    <section aria-label="Campaign links" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-semibold">Links</h2>
        {links.data !== undefined && links.data.items.length > 0 ? (
          <div role="tablist" aria-label="Fold" className="flex gap-1">
            {(Object.keys(FOLDS) as Fold[]).map((f) => (
              <Button
                key={f}
                role="tab"
                aria-selected={f === fold}
                variant={f === fold ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setFold(f)}
              >
                {FOLDS[f]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      {links.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : links.isError ? (
        <p className="text-sm text-destructive">Could not load the campaign's links.</p>
      ) : links.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No links yet.{" "}
          <Link to="/campaigns/$id/add" params={{ id: campaign.id }} className="underline">
            Add links
          </Link>{" "}
          to create one per source and medium.
        </p>
      ) : fold === "link" ? (
        <LinkRows
          links={links.data.items}
          max={Math.max(...links.data.items.map(compared))}
          analytics={analytics}
          rangeHeader={rangeHeader}
          inRange={inRange}
          rangeCell={rangeCell}
          lifetimeCell={lifetimeCell}
        />
      ) : (
        <FoldedRows
          groups={groupByFoldKey(links.data.items, (link) => (fold === "source" ? link.utm?.source : link.utm?.medium) ?? "")
            .map((g) => ({
              ...g,
              lifetime: g.members.reduce((sum, l) => sum + l.clickCount, 0),
              inRange: g.members.reduce((sum, l) => sum + inRange(l), 0),
            }))
            .sort((a, b) => (analytics ? b.inRange - a.inRange : b.lifetime - a.lifetime))}
          header={fold === "source" ? "Source" : "Medium"}
          analytics={analytics}
          rangeHeader={rangeHeader}
          rangeCell={rangeCell}
          lifetimeCell={lifetimeCell}
        />
      )}
    </section>
  );
}

type Cell = (value: number, max: number) => ReactNode;

function LinkRows({
  links,
  max,
  analytics,
  rangeHeader,
  inRange,
  rangeCell,
  lifetimeCell,
}: {
  links: LinkResource[];
  max: number;
  analytics: boolean;
  rangeHeader: string;
  inRange: (link: LinkResource) => number;
  rangeCell: Cell;
  lifetimeCell: Cell;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table aria-label="Links" className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Short URL</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Medium</th>
            <th className="px-3 py-2 font-medium">Content</th>
            <th className="px-3 py-2 font-medium">Term</th>
            <th className="px-3 py-2 text-right font-medium">Lifetime total</th>
            {analytics ? <th className="px-3 py-2 text-right font-medium">{rangeHeader}</th> : null}
          </tr>
        </thead>
        <tbody>
          {links.map((link) => (
            <tr key={link.slug} className={link.enabled ? "border-b last:border-0" : "border-b text-muted-foreground last:border-0"}>
              <td className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to="/links/$slug" params={{ slug: link.slug }} className="font-medium hover:underline">
                    /{link.slug}
                  </Link>
                  <LinkBadges link={link} />
                </div>
              </td>
              <td className="px-3 py-2">{link.utm?.source}</td>
              <td className="px-3 py-2">{link.utm?.medium}</td>
              <td className="px-3 py-2">{link.utm?.content ?? NONE}</td>
              <td className="px-3 py-2">{link.utm?.term ?? NONE}</td>
              {lifetimeCell(link.clickCount, max)}
              {analytics ? rangeCell(inRange(link), max) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FoldedRows({
  groups,
  header,
  analytics,
  rangeHeader,
  rangeCell,
  lifetimeCell,
}: {
  groups: (FoldGroup<LinkResource> & { lifetime: number; inRange: number })[];
  header: string;
  analytics: boolean;
  rangeHeader: string;
  rangeCell: Cell;
  lifetimeCell: Cell;
}) {
  const max = Math.max(...groups.map((g) => (analytics ? g.inRange : g.lifetime)));
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table aria-label={`Links by ${header.toLowerCase()}`} className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">{header}</th>
            <th className="px-3 py-2 text-right font-medium">Links</th>
            <th className="px-3 py-2 text-right font-medium">Lifetime total</th>
            {analytics ? <th className="px-3 py-2 text-right font-medium">{rangeHeader}</th> : null}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key} className="border-b last:border-0">
              <td className="px-3 py-2">{g.label}</td>
              <td className="px-3 py-2 text-right tabular-nums">{g.members.length}</td>
              {lifetimeCell(g.lifetime, max)}
              {analytics ? rangeCell(g.inRange, max) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
