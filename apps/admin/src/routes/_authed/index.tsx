import type { InstanceStats, Link as LinkResource, SeriesPoint } from "@furea/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Copy, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
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
import { AnalyticsHint, ESTIMATE_LABEL, Sparkline, Tiles } from "@/components/analytics";
import { EnableToggle, LinkBadges } from "@/components/link-status";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { deleteLink, LINKS_KEY, linkFeedQuery } from "@/lib/links";
import { analyticsMissing, instanceOverviewQuery } from "@/lib/stats";

const FeedSearch = z.object({
  q: z.string().optional().catch(undefined),
});

/** Typing pauses this long before the search reaches the URL and the API. */
const SEARCH_DEBOUNCE_MS = 250;

export const Route = createFileRoute("/_authed/")({
  validateSearch: FeedSearch,
  component: LinksPage,
});

function LinksPage() {
  const { q = "" } = Route.useSearch();
  const feed = useInfiniteQuery(linkFeedQuery(q));
  const links = feed.data?.pages.flatMap((page) => page.items) ?? [];
  // The feed's sparklines are always the last 7 days (ADR 0005).
  const overview = useQuery(instanceOverviewQuery("7d"));
  const missing = overview.isError ? analyticsMissing(overview.error) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-heading text-xl font-semibold">Links</h1>
        <Link to="/new" className={buttonVariants()}>
          <Plus data-icon="inline-start" />
          New link
        </Link>
      </div>
      {overview.data ? <OverviewTiles stats={overview.data} /> : null}
      {missing ? <AnalyticsHint missing={missing} /> : null}
      <SearchBox q={q} />
      {feed.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : feed.isError ? (
        <p className="text-sm text-destructive">Could not load the links.</p>
      ) : links.length === 0 ? (
        <p className="text-sm text-muted-foreground">{q === "" ? "No links yet." : `No links match “${q}”.`}</p>
      ) : (
        <ul aria-label="Links" className="flex flex-col gap-3">
          {links.map((link) => (
            <li key={link.slug}>
              <LinkCard link={link} series={overview.data ? (overview.data.seriesBySlug[link.slug] ?? ZERO_WEEK) : null} />
            </li>
          ))}
        </ul>
      )}
      {feed.hasNextPage ? (
        <Button variant="outline" className="self-center" disabled={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
          {feed.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}

/** A link without a click this week still gets its flat sparkline. */
const ZERO_WEEK: SeriesPoint[] = Array.from({ length: 7 }, (_, i) => ({ start: String(i), clicks: 0 }));

function OverviewTiles({ stats }: { stats: InstanceStats }) {
  return (
    <Tiles
      tiles={[
        { label: "Today", value: stats.today, hint: ESTIMATE_LABEL },
        { label: "7 days", value: stats.last7d, hint: ESTIMATE_LABEL },
        { label: "30 days", value: stats.last30d, hint: ESTIMATE_LABEL },
        { label: "Links", value: stats.linkCount },
      ]}
    />
  );
}

function SearchBox({ q }: { q: string }) {
  const navigate = useNavigate({ from: Route.fullPath });
  const [value, setValue] = useState(q);

  useEffect(() => {
    const term = value.trim();
    if (term === q) return;
    const timer = setTimeout(() => {
      void navigate({ search: term === "" ? {} : { q: term }, replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, q, navigate]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        aria-label="Search links"
        placeholder="Search by slug, title or destination"
        className="pl-8"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </div>
  );
}

function LinkCard({ link, series }: { link: LinkResource; series: SeriesPoint[] | null }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteLink(link.slug),
    onSuccess: async () => {
      setConfirming(false);
      toast.success(`Deleted /${link.slug}.`);
      await queryClient.invalidateQueries({ queryKey: LINKS_KEY });
    },
    onError: () => toast.error(`Could not delete /${link.slug}. Try again.`),
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.shortUrl);
      toast.success("Short URL copied.");
    } catch {
      toast.error("Could not copy. Select the short URL instead.");
    }
  }

  return (
    <Card size="sm">
      <CardContent className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <a href={link.shortUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              {link.shortUrl.replace(/^https?:\/\//, "")}
            </a>
            <LinkBadges link={link} />
            <span className="text-sm text-muted-foreground" title="Lifetime total">
              {link.clickCount === 1 ? "1 click" : `${link.clickCount.toLocaleString()} clicks`}
            </span>
            {series ? <Sparkline points={series} /> : null}
          </div>
          <Link
            to="/links/$slug"
            params={{ slug: link.slug }}
            className="truncate text-sm text-muted-foreground hover:underline"
            title={link.destination}
          >
            {link.title === null ? null : (
              <>
                <span className="text-foreground">{link.title}</span>
                {" · "}
              </>
            )}
            {link.destination}
          </Link>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={copy}>
            <Copy data-icon="inline-start" />
            Copy
          </Button>
          <EnableToggle link={link} />
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            <Trash2 data-icon="inline-start" />
            Delete
          </Button>
        </div>
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete /{link.slug}?</AlertDialogTitle>
            <AlertDialogDescription>
              Visitors of this short URL will get the not-found page, and the slug becomes free for a new link. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
