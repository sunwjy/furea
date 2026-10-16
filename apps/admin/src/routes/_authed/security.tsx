import {
  ApiKeyName,
  ChangePasswordRequest,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  Scope,
  type ApiKey,
  type CreatedApiKey,
} from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Copy, KeyRound, Trash2 } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, fieldDetails } from "@/lib/api";
import { apiKeysQuery, createApiKey, revokeApiKey } from "@/lib/api-keys";
import { changePassword } from "@/lib/settings";

export const Route = createFileRoute("/_authed/security")({
  component: SecurityPage,
});

function SecurityPage() {
  const keys = useQuery(apiKeysQuery);
  // The key itself lives only in this state: it is never fetched again, so closing the modal is the last chance to copy.
  const [revealed, setRevealed] = useState<CreatedApiKey | null>(null);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="font-heading text-xl font-semibold">Security</h1>
      <PasswordSection />
      <section aria-labelledby="api-keys-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="api-keys-heading" className="font-heading font-semibold">
            API keys
          </h2>
          <p className="text-sm text-muted-foreground">
            Scripts call the API with <code>Authorization: Bearer furea_…</code>. A key can read, or also write links;
            it can never create or revoke keys.
          </p>
        </div>
        <CreateKeyForm onCreated={setRevealed} />
        {keys.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : keys.isError ? (
          <p className="text-sm text-destructive">Could not load the API keys.</p>
        ) : keys.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No API keys yet.</p>
        ) : (
          <ul aria-label="API keys" className="flex flex-col gap-2">
            {keys.data.map((key) => (
              <li key={key.id}>
                <KeyCard apiKey={key} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <RevealedKeyDialog apiKey={revealed} onClose={() => setRevealed(null)} />
    </div>
  );
}

const PasswordForm = ChangePasswordRequest.extend({ confirmPassword: z.string() }).refine(
  ({ newPassword, confirmPassword }) => newPassword === confirmPassword,
  { path: ["confirmPassword"], message: "The two new passwords differ." },
);
type PasswordValues = z.infer<typeof PasswordForm>;

const PASSWORD_FIELDS = ["currentPassword", "newPassword"] as const;

function PasswordSection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<PasswordValues>({
    resolver: zodResolver(PasswordForm),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });
  const { errors, isSubmitting } = form.formState;

  // Changing the password ends every session, this one included (ADR 0003), so success leads to the login page.
  const onSubmit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    try {
      await changePassword({ currentPassword, newPassword });
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_password") {
        form.setError("currentPassword", { message: "The current password is not correct." });
        return;
      }
      const fieldErrors = fieldDetails(error, PASSWORD_FIELDS);
      if (fieldErrors.length === 0) {
        toast.error(error instanceof ApiError ? error.message : "Could not change the password. Try again.");
        return;
      }
      for (const detail of fieldErrors) form.setError(detail.field, { message: detail.message });
      return;
    }
    queryClient.clear();
    toast.success("Password changed. Every session was logged out; log in with the new password.");
    await navigate({ to: "/login" });
  });

  return (
    <section aria-labelledby="password-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="password-heading" className="font-heading font-semibold">
          Password
        </h2>
        <p className="text-sm text-muted-foreground">
          {PASSWORD_MIN_LENGTH} to {PASSWORD_MAX_LENGTH} characters, no other rules. Changing it logs out every session,
          this one included.
        </p>
      </div>
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={errors.currentPassword ? true : undefined}>
            <FieldLabel htmlFor="current-password">Current password</FieldLabel>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              aria-invalid={errors.currentPassword ? true : undefined}
              {...form.register("currentPassword")}
            />
            <FieldError errors={[errors.currentPassword]} />
          </Field>
          <Field data-invalid={errors.newPassword ? true : undefined}>
            <FieldLabel htmlFor="new-password">New password</FieldLabel>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.newPassword ? true : undefined}
              {...form.register("newPassword")}
            />
            <FieldError errors={[errors.newPassword]} />
          </Field>
          <Field data-invalid={errors.confirmPassword ? true : undefined}>
            <FieldLabel htmlFor="confirm-password">New password again</FieldLabel>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={errors.confirmPassword ? true : undefined}
              {...form.register("confirmPassword")}
            />
            <FieldError errors={[errors.confirmPassword]} />
          </Field>
          <Button type="submit" className="self-start" disabled={isSubmitting}>
            {isSubmitting ? "Changing…" : "Change password"}
          </Button>
        </FieldGroup>
      </form>
    </section>
  );
}

const NewApiKeyForm = z.object({ name: ApiKeyName, scope: Scope });
type NewApiKeyInput = z.input<typeof NewApiKeyForm>;
type NewApiKeyValues = z.output<typeof NewApiKeyForm>;

function CreateKeyForm({ onCreated }: { onCreated: (key: CreatedApiKey) => void }) {
  const queryClient = useQueryClient();
  const form = useForm<NewApiKeyInput, unknown, NewApiKeyValues>({
    resolver: zodResolver(NewApiKeyForm),
    defaultValues: { name: "", scope: "read" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (body) => {
    try {
      const key = await createApiKey(body);
      await queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
      form.reset();
      onCreated(key);
    } catch (error) {
      const fieldErrors = fieldDetails(error, ["name", "scope"] as const);
      if (fieldErrors.length === 0) {
        toast.error(error instanceof ApiError ? error.message : "Could not create the key. Try again.");
        return;
      }
      for (const detail of fieldErrors) form.setError(detail.field, { message: detail.message });
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="key-name">Name</FieldLabel>
          <Input
            id="key-name"
            placeholder="backup script"
            autoComplete="off"
            aria-invalid={errors.name ? true : undefined}
            {...form.register("name")}
          />
          <FieldError errors={[errors.name]} />
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Scope</FieldLegend>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" value="read" {...form.register("scope")} />
              Read: list and read links
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" value="write" {...form.register("scope")} />
              Write: also create, edit and delete links
            </label>
          </div>
        </FieldSet>
        <Button type="submit" className="self-start" disabled={isSubmitting}>
          <KeyRound data-icon="inline-start" />
          {isSubmitting ? "Creating…" : "Create key"}
        </Button>
      </FieldGroup>
    </form>
  );
}

function RevealedKeyDialog({ apiKey, onClose }: { apiKey: CreatedApiKey | null; onClose: () => void }) {
  async function copy() {
    if (apiKey === null) return;
    try {
      await navigator.clipboard.writeText(apiKey.key);
      toast.success("API key copied.");
    } catch {
      toast.error("Could not copy. Select the key instead.");
    }
  }

  return (
    <AlertDialog open={apiKey !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Copy the key for {apiKey?.name}</AlertDialogTitle>
          <AlertDialogDescription>
            This is the only time the key is shown. Store it where the script can read it; if it is lost, revoke it and
            create another.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          readOnly
          aria-label="API key"
          className="font-mono text-xs"
          value={apiKey?.key ?? ""}
          onFocus={(event) => event.currentTarget.select()}
        />
        <AlertDialogFooter>
          <Button variant="outline" onClick={copy}>
            <Copy data-icon="inline-start" />
            Copy
          </Button>
          <AlertDialogAction onClick={onClose}>Done</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

function KeyCard({ apiKey }: { apiKey: ApiKey }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => revokeApiKey(apiKey.id),
    onSuccess: async () => {
      setConfirming(false);
      toast.success(`Revoked ${apiKey.name}.`);
      await queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
    },
    onError: () => toast.error(`Could not revoke ${apiKey.name}. Try again.`),
  });

  return (
    <Card size="sm">
      <CardContent className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{apiKey.name}</span>
            <Badge variant={apiKey.scope === "write" ? "default" : "secondary"}>{apiKey.scope}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            <code>furea_{apiKey.prefix}…</code> · Created {formatDate(apiKey.createdAt)} ·{" "}
            {apiKey.lastUsedAt === null ? "Never used" : `Last used ${formatDate(apiKey.lastUsedAt)}`}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          <Trash2 data-icon="inline-start" />
          Revoke
        </Button>
      </CardContent>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {apiKey.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Scripts using this key are refused from their next request. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
