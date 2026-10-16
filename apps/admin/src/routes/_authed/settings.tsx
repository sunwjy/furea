import { Destination, type Settings, type UpdateSettingsRequest } from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ScreeningRefusal } from "@/components/screening-refusal";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, fieldDetails, flaggedHost } from "@/lib/api";
import { settingsQuery, updateSettings } from "@/lib/settings";

export const Route = createFileRoute("/_authed/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const settings = useQuery(settingsQuery);

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <h1 className="font-heading text-xl font-semibold">Settings</h1>
      {settings.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : settings.isError ? (
        <p className="text-sm text-destructive">Could not load the settings.</p>
      ) : (
        <>
          <InstanceFacts settings={settings.data} />
          <RootDestinationForm settings={settings.data} />
        </>
      )}
    </div>
  );
}

function InstanceFacts({ settings }: { settings: Settings }) {
  return (
    <section aria-labelledby="instance-heading" className="flex flex-col gap-3">
      <h2 id="instance-heading" className="font-heading font-semibold">
        Instance
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Version</dt>
        <dd>
          <span>{settings.version}</span>
          <span className="block text-muted-foreground">
            Upgrade with <code>npx furea@latest deploy</code>.
          </span>
        </dd>
        <dt className="text-muted-foreground">Analytics</dt>
        <dd>
          {settings.analyticsConfigured ? (
            "Configured"
          ) : (
            <>
              <span>Not configured</span>
              {settings.analyticsMissing.includes("binding") ? (
                <span className="block text-muted-foreground">
                  No Analytics Engine binding: enable Analytics Engine on the Cloudflare account, then run{" "}
                  <code>npx furea deploy</code> again.
                </span>
              ) : null}
              {settings.analyticsMissing.includes("token") ? (
                <span className="block text-muted-foreground">
                  No analytics token: add one with <code>npx furea analytics-token</code> for click estimates.
                </span>
              ) : null}
            </>
          )}
        </dd>
      </dl>
    </section>
  );
}

/** Empty means no root destination; anything else follows the link-destination rules. */
const RootDestinationField = z.object({
  rootDestination: z
    .string()
    .trim()
    .pipe(z.union([z.literal("").transform(() => null), Destination])),
});
type RootDestinationInput = z.input<typeof RootDestinationField>;
type RootDestinationValues = z.output<typeof RootDestinationField>;

function RootDestinationForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const form = useForm<RootDestinationInput, unknown, RootDestinationValues>({
    resolver: zodResolver(RootDestinationField),
    values: { rootDestination: settings.rootDestination ?? "" },
  });
  const { errors, isSubmitting } = form.formState;
  const typed = form.watch("rootDestination");
  // The refused request, kept for "Save anyway"; it lapses once the field is edited.
  const [refused, setRefused] = useState<{ host: string; body: UpdateSettingsRequest } | null>(null);
  const [overriding, setOverriding] = useState(false);

  const onSubmit = form.handleSubmit(({ rootDestination }) => send({ rootDestination }));

  async function send(body: UpdateSettingsRequest) {
    setRefused(null);
    try {
      const saved = await updateSettings(body);
      queryClient.setQueryData(settingsQuery.queryKey, saved);
      toast.success(saved.rootDestination === null ? "Root destination removed." : "Root destination saved.");
    } catch (error) {
      const host = flaggedHost(error, "rootDestination");
      if (host !== null) {
        setRefused({ host, body });
        return;
      }
      const fieldErrors = fieldDetails(error, ["rootDestination"] as const);
      if (fieldErrors.length === 0) {
        toast.error(error instanceof ApiError ? error.message : "Could not save the settings. Try again.");
        return;
      }
      for (const detail of fieldErrors) form.setError(detail.field, { message: detail.message });
    }
  }

  async function saveAnyway(body: UpdateSettingsRequest) {
    setOverriding(true);
    try {
      await send({ ...body, screening: "skip" });
    } finally {
      setOverriding(false);
    }
  }

  return (
    <section aria-labelledby="root-heading" className="flex flex-col gap-3">
      <h2 id="root-heading" className="font-heading font-semibold">
        Root destination
      </h2>
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={errors.rootDestination ? true : undefined}>
            <FieldLabel htmlFor="root-destination">Where the bare hostname redirects</FieldLabel>
            <Input
              id="root-destination"
              type="url"
              inputMode="url"
              placeholder="https://example.com"
              aria-invalid={errors.rootDestination ? true : undefined}
              {...form.register("rootDestination")}
            />
            <FieldDescription>
              Leave it empty and visitors of the bare hostname get a plain 404. A redirect from it is not a click.
            </FieldDescription>
            <FieldError errors={[errors.rootDestination]} />
          </Field>
          {refused !== null && refused.body.rootDestination === typed.trim() && (
            <ScreeningRefusal
              host={refused.host}
              action="Save anyway"
              pending={overriding || isSubmitting}
              onOverride={() => void saveAnyway(refused.body)}
            />
          )}
          <Button type="submit" className="self-start" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save"}
          </Button>
        </FieldGroup>
      </form>
    </section>
  );
}
