// Campaign edits on the campaign page (ADR 0012 *Rewrites* and *Bulk operations*): the Edit form, whose base URL, UTM
// campaign and utm_id changes rewrite every member after a confirmation naming the link count, and Enable all /
// Disable all.

import { BaseUrl, CampaignName, type Campaign, type UpdateCampaignRequest } from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Power, PowerOff } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
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
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScreeningRefusal } from "@/components/screening-refusal";
import { ApiError, fieldDetails, flaggedHost } from "@/lib/api";
import { CAMPAIGNS_KEY, setCampaignLinksEnabled, updateCampaign } from "@/lib/campaigns";
import { LINKS_KEY } from "@/lib/links";

const EditCampaignForm = z.object({
  name: CampaignName,
  baseUrl: BaseUrl,
  // Named after the parameters, so the browser's own autocomplete suggests earlier values (ADR 0014).
  utm_campaign: z.string().trim().min(1, { message: "Required." }),
  utm_id: z.string().trim(),
});
type EditCampaignInput = z.input<typeof EditCampaignForm>;
type EditCampaignValues = z.output<typeof EditCampaignForm>;

const FIELDS = ["name", "baseUrl"] as const;
const UTM_FIELDS = { utmCampaign: "utm_campaign", utmId: "utm_id" } as const;

const links = (n: number) => (n === 1 ? "1 link" : `${n} links`);

/** Whether the patch changes a field that rewrites every member's destination. */
const rewrites = (body: UpdateCampaignRequest) =>
  body.baseUrl !== undefined || body.utmCampaign !== undefined || body.utmId !== undefined;

export function CampaignEditForm({ campaign, onDone }: { campaign: Campaign; onDone: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<EditCampaignInput, unknown, EditCampaignValues>({
    resolver: zodResolver(EditCampaignForm),
    defaultValues: {
      name: campaign.name,
      baseUrl: campaign.baseUrl,
      utm_campaign: campaign.utmCampaign,
      utm_id: campaign.utmId ?? "",
    },
  });
  const { errors, isSubmitting } = form.formState;
  const baseUrl = form.watch("baseUrl");
  // The patch waiting for the operator to confirm the rewrite.
  const [confirming, setConfirming] = useState<UpdateCampaignRequest | null>(null);
  const [refused, setRefused] = useState<{ host: string; body: UpdateCampaignRequest } | null>(null);
  const [tooLong, setTooLong] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  // Only what changed is sent: a merge-patch, so an unchanged base URL is neither rewritten nor screened.
  const onSubmit = form.handleSubmit(async ({ name, baseUrl, utm_campaign: utmCampaign, utm_id: utmId }) => {
    const body: UpdateCampaignRequest = {};
    if (name !== campaign.name) body.name = name;
    if (baseUrl !== campaign.baseUrl) body.baseUrl = baseUrl;
    if (utmCampaign !== campaign.utmCampaign) body.utmCampaign = utmCampaign;
    if ((utmId === "" ? null : utmId) !== campaign.utmId) body.utmId = utmId === "" ? null : utmId;
    if (rewrites(body) && campaign.linkCount > 0) setConfirming(body);
    else await send(body);
  });

  async function send(body: UpdateCampaignRequest) {
    setConfirming(null);
    setRefused(null);
    setTooLong([]);
    setSending(true);
    try {
      const updated = await updateCampaign(campaign.id, body);
      await queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      await queryClient.invalidateQueries({ queryKey: LINKS_KEY });
      toast.success(
        updated.rewrittenLinkCount > 0
          ? `Saved ${updated.name}; rewrote ${links(updated.rewrittenLinkCount)}.`
          : `Saved ${updated.name}.`,
      );
      onDone();
    } catch (error) {
      const host = flaggedHost(error, "baseUrl");
      if (host !== null) {
        setRefused({ host, body });
        return;
      }
      if (error instanceof ApiError && error.code === "campaign_name_taken") {
        form.setError("name", { message: "Another campaign has this name (compared ignoring case)." });
        return;
      }
      const slugs =
        error instanceof ApiError
          ? error.details.filter((d) => d.code === "rewrite_too_long").map((d) => String(d["slug"]))
          : [];
      if (slugs.length > 0) {
        setTooLong(slugs);
        return;
      }
      const fieldErrors = fieldDetails(error, FIELDS);
      const utmErrors = fieldDetails(error, ["utmCampaign", "utmId"] as const);
      if (fieldErrors.length === 0 && utmErrors.length === 0) {
        toast.error(error instanceof ApiError ? error.message : "Could not save the campaign. Try again.");
        return;
      }
      for (const detail of fieldErrors) form.setError(detail.field, { message: detail.message });
      for (const detail of utmErrors) form.setError(UTM_FIELDS[detail.field], { message: detail.message });
    } finally {
      setSending(false);
    }
  }

  const disabledCount = campaign.linkCount - campaign.enabledLinkCount;
  const pending = isSubmitting || sending;

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Edit campaign">
      <FieldGroup>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input id="name" autoFocus aria-invalid={errors.name ? true : undefined} {...form.register("name")} />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={errors.baseUrl ? true : undefined}>
          <FieldLabel htmlFor="baseUrl">Base URL</FieldLabel>
          <Input
            id="baseUrl"
            type="url"
            inputMode="url"
            aria-invalid={errors.baseUrl ? true : undefined}
            {...form.register("baseUrl")}
          />
          <FieldDescription>No utm_* parameters: the campaign adds them.</FieldDescription>
          <FieldError errors={[errors.baseUrl]} />
        </Field>
        {refused !== null && refused.body.baseUrl === baseUrl && (
          <ScreeningRefusal
            host={refused.host}
            action="Save anyway"
            pending={pending}
            onOverride={() => void send({ ...refused.body, screening: "skip" })}
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errors.utm_campaign ? true : undefined}>
            <FieldLabel htmlFor="utmCampaign">UTM campaign</FieldLabel>
            <Input
              id="utmCampaign"
              autoComplete="on"
              aria-invalid={errors.utm_campaign ? true : undefined}
              {...form.register("utm_campaign")}
            />
            <FieldDescription>
              <code>utm_campaign</code>
            </FieldDescription>
            <FieldError errors={[errors.utm_campaign]} />
          </Field>
          <Field data-invalid={errors.utm_id ? true : undefined}>
            <FieldLabel htmlFor="utmId">Campaign ID (optional)</FieldLabel>
            <Input
              id="utmId"
              autoComplete="on"
              aria-invalid={errors.utm_id ? true : undefined}
              {...form.register("utm_id")}
            />
            <FieldDescription>
              <code>utm_id</code>
            </FieldDescription>
            <FieldError errors={[errors.utm_id]} />
          </Field>
        </div>
        {tooLong.length > 0 && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
            Nothing was saved: the destination of {tooLong.map((slug) => `/${slug}`).join(", ")} would be longer than
            2048 characters. Shorten the base URL or those links' UTM values.
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={onDone}>
            Cancel
          </Button>
        </div>
      </FieldGroup>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => (open ? null : setConfirming(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rewrite {links(campaign.linkCount)}?</AlertDialogTitle>
            <AlertDialogDescription>
              This rewrites the destination of {campaign.linkCount === 1 ? "the" : `all ${campaign.linkCount}`}{" "}
              {campaign.linkCount === 1 ? "link" : "links"} in the campaign
              {disabledCount > 0 ? `, ${disabledCount} disabled included` : ""}.
            </AlertDialogDescription>
            {confirming?.utmCampaign !== undefined ? (
              <AlertDialogDescription>
                The UTM campaign changes to <code>{confirming.utmCampaign}</code>: the destination site's analytics will
                see a new campaign from now on.
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={() => confirming !== null && void send(confirming)}>
              Rewrite {links(campaign.linkCount)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

/** Enable all / Disable all: a bulk action over the members, not a campaign state (ADR 0012). */
export function CampaignBulkToggle({ campaign }: { campaign: Campaign }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setCampaignLinksEnabled(campaign.id, enabled),
    onSuccess: async ({ updated }, enabled) => {
      setConfirming(false);
      toast.success(`${enabled ? "Enabled" : "Disabled"} ${links(updated)}.`);
      await queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      await queryClient.invalidateQueries({ queryKey: LINKS_KEY });
    },
    onError: (_error, enabled) => toast.error(`Could not ${enabled ? "enable" : "disable"} the links. Try again.`),
  });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={toggle.isPending || campaign.enabledLinkCount === campaign.linkCount}
        onClick={() => toggle.mutate(true)}
      >
        <Power data-icon="inline-start" />
        Enable all
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={toggle.isPending || campaign.enabledLinkCount === 0}
        onClick={() => setConfirming(true)}
      >
        <PowerOff data-icon="inline-start" />
        Disable all
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable {links(campaign.linkCount)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Each short URL of {campaign.name} answers 404 until it is enabled again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>
              Disable all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
