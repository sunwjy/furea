import { Destination, Title, type Link as LinkResource, type UpdateLinkRequest } from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Pencil } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { EnableToggle, LinkBadges, SyncPendingNotice, useUpdateLink } from "@/components/link-status";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, fieldDetails } from "@/lib/api";
import { linkQuery } from "@/lib/links";

// `/link/$slug`, not `/links/$slug`: under `/links/` the static `/links/new` would hide a link whose slug is `new`.
export const Route = createFileRoute("/_authed/link/$slug")({
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
        <EditForm link={link} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Destination</dt>
            <dd className="break-all">{link.destination}</dd>
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
        </>
      )}
    </>
  );
}

/** The editable fields' own schemas; the slug is never editable (ADR 0002). */
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

  // Only what changed is sent: a merge-patch, and an unchanged destination is not set again.
  const onSubmit = form.handleSubmit(async ({ destination, title }) => {
    const body: UpdateLinkRequest = {};
    if (destination !== link.destination) body.destination = destination;
    if (title !== link.title) body.title = title;
    try {
      await update.mutateAsync(body);
      toast.success(`Saved /${link.slug}.`);
      onDone();
    } catch (error) {
      const fieldErrors = fieldDetails(error, FIELDS);
      if (fieldErrors.length === 0) {
        toast.error(error instanceof ApiError ? error.message : "Could not save the link. Try again.");
        return;
      }
      for (const detail of fieldErrors) form.setError(detail.field, { message: detail.message });
    }
  });

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
