import { CAMPAIGN_LINK_LIMIT, type Campaign } from "@furea/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { LinkBadges } from "@/components/link-status";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { CAMPAIGNS_KEY, campaignLinksQuery, campaignQuery, deleteCampaign } from "@/lib/campaigns";
import { LINKS_KEY } from "@/lib/links";

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
          <CampaignLinksTable campaign={campaign.data} />
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
        <dt className="text-muted-foreground">Links</dt>
        <dd>
          {campaign.linkCount} of {CAMPAIGN_LINK_LIMIT}
          {campaign.enabledLinkCount < campaign.linkCount ? `, ${campaign.enabledLinkCount} enabled` : null}
        </dd>
        <dt className="text-muted-foreground">Lifetime total</dt>
        <dd>{campaign.clickCount.toLocaleString()}</dd>
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

function CampaignLinksTable({ campaign }: { campaign: Campaign }) {
  const links = useQuery(campaignLinksQuery(campaign.id));

  return (
    <section aria-label="Campaign links" className="flex flex-col gap-2">
      <h2 className="font-heading text-base font-semibold">Links</h2>
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
      ) : (
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
              </tr>
            </thead>
            <tbody>
              {links.data.items.map((link) => (
                <tr key={link.slug} className={link.enabled ? "border-b last:border-0" : "border-b text-muted-foreground last:border-0"}>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to="/links/$slug" params={{ slug: link.slug }} className="font-medium hover:underline">
                        /{link.slug}
                      </Link>
                      <LinkBadges link={link} showCampaign={false} />
                    </div>
                  </td>
                  <td className="px-3 py-2">{link.utm?.source}</td>
                  <td className="px-3 py-2">{link.utm?.medium}</td>
                  <td className="px-3 py-2">{link.utm?.content ?? NONE}</td>
                  <td className="px-3 py-2">{link.utm?.term ?? NONE}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{link.clickCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
