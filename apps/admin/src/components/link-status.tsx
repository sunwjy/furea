// A link's state and the two writes that change it without a form: Disable/Enable, and Retry now for a link that is
// sync pending (ADR 0004). Shared by the feed's cards and the link page.

import type { Link as LinkResource, UpdateLinkRequest } from "@furea/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Power, PowerOff, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isLinkListQuery, LINKS_KEY, linkQuery, updateLink } from "@/lib/links";

/** A `PATCH` on one link; the link page's query takes the answer as is, every other link query refetches. */
export function useUpdateLink(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateLinkRequest) => updateLink(slug, body),
    onSuccess: async (link) => {
      queryClient.setQueryData(linkQuery(slug).queryKey, link);
      await queryClient.invalidateQueries({ queryKey: LINKS_KEY, predicate: isLinkListQuery });
    },
  });
}

export function LinkBadges({ link }: { link: LinkResource }) {
  return (
    <>
      {link.enabled ? null : <Badge variant="secondary">Disabled</Badge>}
      {link.cacheSynced ? null : <Badge variant="outline">Sync pending</Badge>}
    </>
  );
}

export function EnableToggle({ link }: { link: LinkResource }) {
  const update = useUpdateLink(link.slug);
  const enabling = !link.enabled;

  function toggle() {
    update.mutate(
      { enabled: enabling },
      {
        onSuccess: () => toast.success(enabling ? `Enabled /${link.slug}.` : `Disabled /${link.slug}.`),
        onError: () => toast.error(`Could not ${enabling ? "enable" : "disable"} /${link.slug}. Try again.`),
      },
    );
  }

  return (
    <Button variant="ghost" size="sm" disabled={update.isPending} onClick={toggle}>
      {enabling ? <Power data-icon="inline-start" /> : <PowerOff data-icon="inline-start" />}
      {enabling ? "Enable" : "Disable"}
    </Button>
  );
}

/** Shown while the link is sync pending: a state, never an error. */
export function SyncPendingNotice({ link }: { link: LinkResource }) {
  const update = useUpdateLink(link.slug);
  if (link.cacheSynced) return null;

  function retry() {
    update.mutate(
      {},
      {
        onSuccess: (result) =>
          result.cacheSynced
            ? toast.success(`/${link.slug} is live everywhere.`)
            : toast.info("Still pending. The instance keeps retrying on its own."),
        onError: () => toast.error("Could not retry. Try again."),
      },
    );
  }

  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
      <p className="flex-1">
        The latest change is saved but has not reached the redirect cache yet, so visitors may still see the previous
        version. The instance retries on its own within a few minutes.
      </p>
      <Button variant="outline" size="sm" disabled={update.isPending} onClick={retry}>
        <RefreshCw data-icon="inline-start" />
        Retry now
      </Button>
    </div>
  );
}
