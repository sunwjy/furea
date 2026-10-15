import { CustomSlug, Destination, Title, type CreateLinkRequest } from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, fieldDetails } from "@/lib/api";
import { createLink, LINKS_KEY } from "@/lib/links";

export const Route = createFileRoute("/_authed/links/new")({
  component: NewLinkPage,
});

/** The create request's own field schemas; an empty optional input means "not given". */
const NewLinkForm = z.object({
  destination: Destination,
  slug: z.literal("").or(CustomSlug),
  title: Title,
});
type NewLinkInput = z.input<typeof NewLinkForm>;
type NewLinkValues = z.output<typeof NewLinkForm>;

const FIELDS = ["destination", "slug", "title"] as const;

function NewLinkPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<NewLinkInput, unknown, NewLinkValues>({
    resolver: zodResolver(NewLinkForm),
    defaultValues: { destination: "", slug: "", title: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ destination, slug, title }) => {
    const body: CreateLinkRequest = { destination };
    if (slug !== "") body.slug = slug;
    if (title !== null) body.title = title;
    try {
      const link = await createLink(body);
      await queryClient.invalidateQueries({ queryKey: LINKS_KEY });
      toast.success(`Created ${link.shortUrl}.`);
      await navigate({ to: "/" });
    } catch (error) {
      showServerErrors(error);
    }
  });

  /** The API's per-field details land on the matching inputs; anything else is a toast. */
  function showServerErrors(error: unknown) {
    if (error instanceof ApiError && error.code === "slug_taken") {
      form.setError("slug", { message: "This slug is taken. Choose another one." });
      return;
    }
    const fieldErrors = fieldDetails(error, FIELDS);
    if (fieldErrors.length === 0) {
      toast.error(error instanceof ApiError ? error.message : "Could not create the link. Try again.");
      return;
    }
    for (const detail of fieldErrors) form.setError(detail.field, { message: detail.message });
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link to="/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          Links
        </Link>
        <h1 className="font-heading text-xl font-semibold">New link</h1>
      </div>
      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={errors.destination ? true : undefined}>
            <FieldLabel htmlFor="destination">Destination</FieldLabel>
            <Input
              id="destination"
              type="url"
              inputMode="url"
              placeholder="https://example.com/page"
              autoFocus
              aria-invalid={errors.destination ? true : undefined}
              {...form.register("destination")}
            />
            <FieldError errors={[errors.destination]} />
          </Field>
          <Field data-invalid={errors.slug ? true : undefined}>
            <FieldLabel htmlFor="slug">Custom slug (optional)</FieldLabel>
            <Input
              id="slug"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.slug ? true : undefined}
              {...form.register("slug")}
            />
            <FieldDescription>Letters, digits, - and _. Case-sensitive. Leave empty for a generated slug.</FieldDescription>
            <FieldError errors={[errors.slug]} />
          </Field>
          <Field data-invalid={errors.title ? true : undefined}>
            <FieldLabel htmlFor="title">Title (optional)</FieldLabel>
            <Input id="title" aria-invalid={errors.title ? true : undefined} {...form.register("title")} />
            <FieldDescription>Only you see it, in the link feed.</FieldDescription>
            <FieldError errors={[errors.title]} />
          </Field>
          <Button type="submit" className="self-start" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create link"}
          </Button>
        </FieldGroup>
      </form>
    </div>
  );
}
