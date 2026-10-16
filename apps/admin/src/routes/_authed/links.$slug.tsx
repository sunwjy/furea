import {
  Destination,
  Title,
  type Link as LinkResource,
  type StatsRange,
  type UpdateLinkRequest,
} from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Unlink } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CampaignLinkEditForm } from "@/components/campaign-link-edit";
import { AnalyticsHint, BarSeries, ESTIMATE_LABEL, RangeTabs, TopList } from "@/components/analytics";
import { EnableToggle, LinkBadges, SyncPendingNotice, useUpdateLink } from "@/components/link-status";
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
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScreeningRefusal, useScreeningOverride } from "@/components/screening-refusal";
import { composeInto, UtmBuilder } from "@/components/utm-builder";
import { ApiError, fieldDetails } from "@/lib/api";
import { campaignListQuery } from "@/lib/campaigns";
import { linkQuery } from "@/lib/links";
import { analyticsMissing, browserTimeZone, linkBreakdownsQuery } from "@/lib/stats";

// Nothing static lives under `/links/`: any word there is also a valid custom slug, so the new-link page is `/new`.
export const Route = createFileRoute("/_authed/links/$slug")({
  component: LinkPage,
});

function LinkPage() {
  const { slug } = Route.useParams();
  const link = useQuery(linkQuery(slug));

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Link to="/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Links
      </Link>
      {link.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : link.isError ? (
        <p className="text-sm text-destructive">
          {link.error instanceof ApiError && link.error.status === 404
            ? `There is no link /${slug}.`
            : "Could not load the link."}
        </p>
      ) : (
        <LinkDetails link={link.data} />
      )}
    </div>
  );
}

function LinkDetails({ link }: { link: LinkResource }) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-xl font-semibold">/{link.slug}</h1>
          <LinkBadges link={link} />
        </div>
        <a href={link.shortUrl} target="_blank" rel="noreferrer" className="text-sm text-muted-foreground hover:underline">
          {link.shortUrl}
        </a>
      </div>
      <SyncPendingNotice link={link} />
      {editing ? (
        link.campaign !== null ? (
          <CampaignLinkEditForm link={link} onDone={() => setEditing(false)} />
        ) : (
          <EditForm link={link} onDone={() => setEditing(false)} />
        )
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Destination</dt>
            <dd className="break-all">{link.destination}</dd>
            {link.campaign === null || link.utm === null ? null : (
              <>
                <dt className="text-muted-foreground">Campaign</dt>
                <dd>
                  <Link to="/campaigns/$id" params={{ id: link.campaign.id }} className="hover:underline">
                    {link.campaign.name}
                  </Link>
                </dd>
                <dt className="text-muted-foreground">UTM</dt>
                <dd>{[link.utm.source, link.utm.medium, link.utm.content, link.utm.term].filter(Boolean).join(" / ")}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Title</dt>
            <dd>{link.title ?? <span className="text-muted-foreground">None</span>}</dd>
            <dt className="text-muted-foreground">Lifetime total</dt>
            <dd>{link.clickCount.toLocaleString()}</dd>
          </dl>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil data-icon="inline-start" />
              Edit
            </Button>
            <EnableToggle link={link} />
          </div>
          <Membership link={link} />
        </>
      )}
      <LinkAnalytics slug={link.slug} />
    </>
  );
}

/**
 * Campaign membership (ADR 0012): Detach for a campaign link, "Add to campaign…" (adopt) for a plain one, with the
 * refusal reason when its destination does not match the chosen campaign.
 */
function Membership({ link }: { link: LinkResource }) {
  const update = useUpdateLink(link.slug);
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const campaigns = useInfiniteQuery({ ...campaignListQuery(), enabled: link.campaign === null });
  const options = campaigns.data?.pages.flatMap((page) => page.items) ?? [];

  function detach() {
    update.mutate(
      { campaign: null },
      {
        onSuccess: () => {
          setConfirming(false);
          toast.success(`Detached /${link.slug}.`);
        },
        onError: () => toast.error(`Could not detach /${link.slug}. Try again.`),
      },
    );
  }

  function adopt(id: string) {
    setRefusal(null);
    update.mutate(
      { campaign: { id } },
      {
        onSuccess: (adopted) => toast.success(`Added /${link.slug} to ${adopted.campaign?.name ?? "the campaign"}.`),
        onError: (error) => {
          const name = options.find((campaign) => campaign.id === id)?.name ?? "the campaign";
          setRefusal(
            error instanceof ApiError
              ? `Cannot add /${link.slug} to ${name}: ${error.message}`
              : "Could not add the link to the campaign. Try again.",
          );
        },
      },
    );
  }

  if (link.campaign !== null) {
    const name = link.campaign.name;
    return (
      <section aria-label="Campaign" className="flex flex-wrap items-center gap-2 text-sm">
        <p className="flex-1 text-muted-foreground">
          In the campaign <span className="text-foreground">{name}</span>, which composes its destination.
        </p>
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          <Unlink data-icon="inline-start" />
          Detach
        </Button>
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Detach /{link.slug} from {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                It becomes a plain link: its destination and click history stay as they are, and its clicks no longer
                count under the campaign.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={update.isPending} onClick={detach}>
                Detach
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    );
  }

  if (options.length === 0) return null;
  return (
    <section aria-label="Campaign" className="flex flex-col gap-2 text-sm">
      <select
        aria-label="Add to campaign"
        value=""
        disabled={update.isPending}
        onChange={(event) => {
          if (event.target.value !== "") adopt(event.target.value);
        }}
        className="h-8 w-fit rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        <option value="">Add to campaign…</option>
        {options.map((campaign) => (
          <option key={campaign.id} value={campaign.id}>
            {campaign.name}
          </option>
        ))}
      </select>
      {refusal === null ? null : (
        <p role="alert" className="text-destructive">
          {refusal}
        </p>
      )}
    </section>
  );
}

/** The link's breakdowns for a range (ADR 0005), or the degraded hint; the lifetime total above stays either way. */
function LinkAnalytics({ slug }: { slug: string }) {
  const [range, setRange] = useState<StatsRange>("7d");
  const stats = useQuery(linkBreakdownsQuery(slug, range));
  const missing = stats.isError ? analyticsMissing(stats.error) : null;

  if (missing) return <AnalyticsHint missing={missing} dismissible={false} />;

  return (
    <section aria-label="Clicks" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-semibold">Clicks</h2>
        <RangeTabs range={range} onChange={setRange} />
      </div>
      <p className="text-xs text-muted-foreground">
        {ESTIMATE_LABEL}, in {browserTimeZone()} {range === "24h" ? "hours" : "days"}.
      </p>
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

/** A plain link's editable fields' own schemas; the slug is never editable (ADR 0002). */
const EditLinkForm = z.object({ destination: Destination, title: Title });
type EditLinkInput = z.input<typeof EditLinkForm>;
type EditLinkValues = z.output<typeof EditLinkForm>;

const FIELDS = ["destination", "title"] as const;

function EditForm({ link, onDone }: { link: LinkResource; onDone: () => void }) {
  const update = useUpdateLink(link.slug);
  const form = useForm<EditLinkInput, unknown, EditLinkValues>({
    resolver: zodResolver(EditLinkForm),
    defaultValues: { destination: link.destination, title: link.title ?? "" },
  });
  const { errors, isSubmitting } = form.formState;
  const destination = form.watch("destination");
  // The refused request, kept for "Save anyway"; it lapses once the destination is edited.
  const screening = useScreeningOverride<UpdateLinkRequest>("destination");
  const { refused } = screening;

  // Only what changed is sent: a merge-patch, and an unchanged destination is not set again.
  const onSubmit = form.handleSubmit(async ({ destination, title }) => {
    const body: UpdateLinkRequest = {};
    if (destination !== link.destination) body.destination = destination;
    if (title !== link.title) body.title = title;
    await send(body);
  });

  async function send(body: UpdateLinkRequest) {
    screening.clear();
    try {
      await update.mutateAsync(body);
      toast.success(`Saved /${link.slug}.`);
      onDone();
    } catch (error) {
      if (screening.catchRefusal(error, body)) return;
      const fieldErrors = fieldDetails(error, FIELDS);
      if (fieldErrors.length === 0) {
        toast.error(error instanceof ApiError ? error.message : "Could not save the link. Try again.");
        return;
      }
      for (const detail of fieldErrors) form.setError(detail.field, { message: detail.message });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <Field data-invalid={errors.destination ? true : undefined}>
          <FieldLabel htmlFor="destination">Destination</FieldLabel>
          <Input
            id="destination"
            type="url"
            inputMode="url"
            autoFocus
            aria-invalid={errors.destination ? true : undefined}
            {...form.register("destination")}
          />
          <FieldError errors={[errors.destination]} />
        </Field>
        {refused !== null && refused.body.destination === destination && (
          <ScreeningRefusal
            host={refused.host}
            action="Save anyway"
            pending={screening.overriding || update.isPending || isSubmitting}
            onOverride={() => void screening.override(send)}
          />
        )}
        <UtmBuilder destination={destination} onCompose={composeInto(form, "destination")} />
        <Field data-invalid={errors.title ? true : undefined}>
          <FieldLabel htmlFor="title">Title (optional)</FieldLabel>
          <Input id="title" aria-invalid={errors.title ? true : undefined} {...form.register("title")} />
          <FieldDescription>Only you see it, in the link feed.</FieldDescription>
          <FieldError errors={[errors.title]} />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="ghost" disabled={isSubmitting} onClick={onDone}>
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
