import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { campaignListQuery } from "@/lib/campaigns";

export const Route = createFileRoute("/_authed/campaigns/")({
  component: CampaignsPage,
});

/** The campaign list reads D1 only: link counts and lifetime totals, no analytics query (ADR 0005). */
function CampaignsPage() {
  const list = useInfiniteQuery(campaignListQuery());
  const campaigns = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-xl font-semibold">Campaigns</h1>
        <Link to="/campaigns/new" className={buttonVariants()}>
          <Plus data-icon="inline-start" />
          New campaign
        </Link>
      </div>
      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.isError ? (
        <p className="text-sm text-destructive">Could not load the campaigns.</p>
      ) : campaigns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No campaigns yet. A campaign groups the links of one landing page by source and medium.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table aria-label="Campaigns" className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">UTM campaign</th>
                <th className="px-3 py-2 text-right font-medium">Links</th>
                <th className="px-3 py-2 text-right font-medium">Lifetime total</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to="/campaigns/$id" params={{ id: campaign.id }} className="font-medium hover:underline">
                        {campaign.name}
                      </Link>
                      {campaign.syncPendingLinkCount > 0 ? (
                        <Badge variant="outline">{campaign.syncPendingLinkCount} sync pending</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <code className="text-xs">{campaign.utmCampaign}</code>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {campaign.linkCount}
                    {campaign.enabledLinkCount < campaign.linkCount ? (
                      <span className="text-muted-foreground">
                        {" "}
                        ({campaign.linkCount - campaign.enabledLinkCount} disabled)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{campaign.clickCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage ? (
        <Button variant="outline" className="self-center" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
