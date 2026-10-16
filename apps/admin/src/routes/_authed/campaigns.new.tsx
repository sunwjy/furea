import { BaseUrl, CampaignName, type CreateCampaignRequest } from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScreeningRefusal, useScreeningOverride } from "@/components/screening-refusal";
import { ApiError, fieldDetails } from "@/lib/api";
import { CAMPAIGNS_KEY, campaignListQuery, createCampaign } from "@/lib/campaigns";

export const Route = createFileRoute("/_authed/campaigns/new")({
  component: NewCampaignPage,
});

/** The UTM fields stay outside the form: they are free text, and the UTM campaign mirrors the name until edited. */
const NewCampaignForm = z.object({ name: CampaignName, baseUrl: BaseUrl });
type NewCampaignInput = z.input<typeof NewCampaignForm>;
type NewCampaignValues = z.output<typeof NewCampaignForm>;

const FIELDS = ["name", "baseUrl"] as const;
const UTM_FIELDS = ["utmCampaign", "utmId"] as const;

/** Typing pauses this long before the UTM campaign is looked up among the other campaigns. */
const LOOKUP_DEBOUNCE_MS = 300;

function NewCampaignPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<NewCampaignInput, unknown, NewCampaignValues>({
    resolver: zodResolver(NewCampaignForm),
    defaultValues: { name: "", baseUrl: "" },
  });
  const { errors, isSubmitting } = form.formState;
  const [name, baseUrl] = form.watch(["name", "baseUrl"]);
  // The UTM campaign follows the trimmed name, case kept (ADR 0012), until the operator types one of their own.
  const [typedUtmCampaign, setTypedUtmCampaign] = useState<string | null>(null);
  const [utmId, setUtmId] = useState("");
  const [utmErrors, setUtmErrors] = useState<Partial<Record<(typeof UTM_FIELDS)[number], string>>>({});
  const utmCampaign = (typedUtmCampaign ?? name).trim();
  const reusedBy = useUtmCampaignHolder(utmCampaign);
  const screening = useScreeningOverride<CreateCampaignRequest>("baseUrl");
  const { refused } = screening;

  const onSubmit = form.handleSubmit(async ({ name, baseUrl }) => {
    const body: CreateCampaignRequest = { name, baseUrl };
    if (utmCampaign !== "") body.utmCampaign = utmCampaign;
    if (utmId.trim() !== "") body.utmId = utmId;
    await send(body);
  });

  async function send(body: CreateCampaignRequest) {
    screening.clear();
    setUtmErrors({});
    try {
      const campaign = await createCampaign(body);
      await queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      toast.success(`Created ${campaign.name}. Add its links now.`);
      await navigate({ to: "/campaigns/$id/add", params: { id: campaign.id } });
    } catch (error) {
      if (screening.catchRefusal(error, body)) return;
      if (error instanceof ApiError && error.code === "campaign_name_taken") {
        form.setError("name", { message: "Another campaign has this name (compared ignoring case)." });
        return;
      }
      const fieldErrors = fieldDetails(error, FIELDS);
      const utmFieldErrors = fieldDetails(error, UTM_FIELDS);
      if (fieldErrors.length === 0 && utmFieldErrors.length === 0) {
        toast.error(error instanceof ApiError ? error.message : "Could not create the campaign. Try again.");
        return;
      }
      for (const detail of fieldErrors) form.setError(detail.field, { message: detail.message });
      setUtmErrors(Object.fromEntries(utmFieldErrors.map((detail) => [detail.field, detail.message])));
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link to="/campaigns" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          Campaigns
        </Link>
        <h1 className="font-heading text-xl font-semibold">New campaign</h1>
      </div>
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={errors.name ? true : undefined}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              autoFocus
              placeholder="Spring sale 2026"
              aria-invalid={errors.name ? true : undefined}
              {...form.register("name")}
            />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field data-invalid={errors.baseUrl ? true : undefined}>
            <FieldLabel htmlFor="baseUrl">Base URL</FieldLabel>
            <Input
              id="baseUrl"
              type="url"
              inputMode="url"
              placeholder="https://shop.example.com/spring"
              aria-invalid={errors.baseUrl ? true : undefined}
              {...form.register("baseUrl")}
            />
            <FieldDescription>Where every link of the campaign lands. No utm_* parameters: the campaign adds them.</FieldDescription>
            <FieldError errors={[errors.baseUrl]} />
          </Field>
          {refused !== null && refused.body.baseUrl === baseUrl && (
            <ScreeningRefusal
              host={refused.host}
              action="Create anyway"
              pending={screening.overriding || isSubmitting}
              onOverride={() => void screening.override(send)}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={utmErrors.utmCampaign ? true : undefined}>
              <FieldLabel htmlFor="utmCampaign">UTM campaign</FieldLabel>
              {/* The parameter's name, so the browser's own autocomplete suggests earlier values (ADR 0014). */}
              <Input
                id="utmCampaign"
                name="utm_campaign"
                autoComplete="on"
                aria-invalid={utmErrors.utmCampaign ? true : undefined}
                value={typedUtmCampaign ?? name}
                onChange={(event) => setTypedUtmCampaign(event.target.value)}
              />
              <FieldDescription>
                <code>utm_campaign</code>
                {typedUtmCampaign === null ? ", follows the name until you edit it" : null}
              </FieldDescription>
              <FieldError>{utmErrors.utmCampaign}</FieldError>
            </Field>
            <Field data-invalid={utmErrors.utmId ? true : undefined}>
              <FieldLabel htmlFor="utmId">Campaign ID (optional)</FieldLabel>
              <Input
                id="utmId"
                name="utm_id"
                autoComplete="on"
                aria-invalid={utmErrors.utmId ? true : undefined}
                value={utmId}
                onChange={(event) => setUtmId(event.target.value)}
              />
              <FieldDescription>
                <code>utm_id</code>
              </FieldDescription>
              <FieldError>{utmErrors.utmId}</FieldError>
            </Field>
          </div>
          {reusedBy !== null ? (
            <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              “{reusedBy}” already uses this UTM campaign; the destination site's analytics will count both campaigns
              together.
            </p>
          ) : null}
          <Button type="submit" className="self-start" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create and add links"}
          </Button>
        </FieldGroup>
      </form>
    </div>
  );
}

/** The name of another campaign carrying exactly this UTM campaign: a warning, never an error (ADR 0012). */
function useUtmCampaignHolder(utmCampaign: string): string | null {
  const [term, setTerm] = useState(utmCampaign);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(utmCampaign), LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [utmCampaign]);
  const list = useInfiniteQuery({ ...campaignListQuery(term), enabled: term !== "" });
  if (term === "" || term !== utmCampaign) return null;
  const holder = list.data?.pages.flatMap((page) => page.items).find((c) => c.utmCampaign === term);
  return holder?.name ?? null;
}
