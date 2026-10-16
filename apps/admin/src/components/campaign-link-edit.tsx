// A campaign link's edit form (ADR 0012, ADR 0014): its own UTM values and title. The destination is composed from
// the campaign, so it is shown read-only and recomposed by the Worker; detaching is the way to send it elsewhere.

import { Title, type Link as LinkResource, type UpdateLinkRequest } from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useUpdateLink } from "@/components/link-status";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, fieldDetails } from "@/lib/api";
import { CAMPAIGNS_KEY } from "@/lib/campaigns";

const Required = z.string().trim().min(1, { message: "Required." });

// Named after the parameters, so the browser's own autocomplete suggests earlier values (ADR 0014).
const EditCampaignLinkForm = z.object({
  utm_source: Required,
  utm_medium: Required,
  utm_content: z.string().trim(),
  utm_term: z.string().trim(),
  title: Title,
});
type EditCampaignLinkInput = z.input<typeof EditCampaignLinkForm>;
type EditCampaignLinkValues = z.output<typeof EditCampaignLinkForm>;

const UTM_FIELDS = [
  { name: "utm_source", label: "Source" },
  { name: "utm_medium", label: "Medium" },
  { name: "utm_content", label: "Content (optional)" },
  { name: "utm_term", label: "Term (optional)" },
] as const;

export function CampaignLinkEditForm({ link, onDone }: { link: LinkResource; onDone: () => void }) {
  const queryClient = useQueryClient();
  const update = useUpdateLink(link.slug);
  const utm = link.utm ?? { source: "", medium: "", content: null, term: null };
  const form = useForm<EditCampaignLinkInput, unknown, EditCampaignLinkValues>({
    resolver: zodResolver(EditCampaignLinkForm),
    defaultValues: {
      utm_source: utm.source,
      utm_medium: utm.medium,
      utm_content: utm.content ?? "",
      utm_term: utm.term ?? "",
      title: link.title ?? "",
    },
  });
  const { errors, isSubmitting } = form.formState;

  // Only what changed is sent, the UTM values as a merge-patch inside `utm`.
  const onSubmit = form.handleSubmit(async (values) => {
    const own: NonNullable<UpdateLinkRequest["utm"]> = {};
    if (values.utm_source !== utm.source) own.source = values.utm_source;
    if (values.utm_medium !== utm.medium) own.medium = values.utm_medium;
    if (values.utm_content !== (utm.content ?? "")) own.content = values.utm_content === "" ? null : values.utm_content;
    if (values.utm_term !== (utm.term ?? "")) own.term = values.utm_term === "" ? null : values.utm_term;
    const body: UpdateLinkRequest = {};
    if (Object.keys(own).length > 0) body.utm = own;
    if (values.title !== link.title) body.title = values.title;
    try {
      await update.mutateAsync(body);
      await queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      toast.success(`Saved /${link.slug}.`);
      onDone();
    } catch (error) {
      if (error instanceof ApiError && error.code === "utm_combination_taken") {
        form.setError("root", { message: error.message });
        return;
      }
      const utmErrors = fieldDetails(error, ["utm"] as const);
      const titleErrors = fieldDetails(error, ["title"] as const);
      if (utmErrors.length === 0 && titleErrors.length === 0) {
        toast.error(error instanceof ApiError ? error.message : "Could not save the link. Try again.");
        return;
      }
      for (const detail of utmErrors) form.setError("root", { message: detail.message });
      for (const detail of titleErrors) form.setError("title", { message: detail.message });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Edit link">
      <FieldGroup>
        <Field>
          <FieldLabel>Destination</FieldLabel>
          <p className="text-sm break-all">{link.destination}</p>
          <FieldDescription>
            Composed from the campaign {link.campaign?.name} and the values below. Detach the link to edit its
            destination.
          </FieldDescription>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {UTM_FIELDS.map(({ name, label }) => (
            <Field key={name} data-invalid={errors[name] ? true : undefined}>
              <FieldLabel htmlFor={name}>{label}</FieldLabel>
              <Input id={name} autoComplete="on" aria-invalid={errors[name] ? true : undefined} {...form.register(name)} />
              <FieldDescription>
                <code>{name}</code>
              </FieldDescription>
              <FieldError errors={[errors[name]]} />
            </Field>
          ))}
        </div>
        {link.clickCount > 0 ? (
          <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            This link already has {link.clickCount.toLocaleString()} clicks. Clicks are recorded per slug, so past clicks
            will count under the new values.
          </p>
        ) : null}
        {errors.root ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.root.message}
          </p>
        ) : null}
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
