import { LoginRequest } from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { login, loginMethodQuery, sessionQuery } from "@/lib/auth";

const LoginSearch = z.object({
  // Only an in-app path, so the login page can never send the operator to another site.
  redirect: z
    .string()
    .regex(/^\/(?!\/)/)
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/login")({
  validateSearch: LoginSearch,
  beforeLoad: async ({ context }) => {
    if ((await context.queryClient.ensureQueryData(sessionQuery)) !== null) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const method = useQuery(loginMethodQuery);
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-heading text-xl">furea</CardTitle>
          <CardDescription>
            {method.data?.method === "access"
              ? "This instance signs in through Cloudflare Access."
              : "Enter the operator password."}
          </CardDescription>
        </CardHeader>
        {method.data?.method === "access" ? null : (
          <CardContent>
            <PasswordForm />
          </CardContent>
        )}
      </Card>
    </main>
  );
}

function PasswordForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const form = useForm<LoginRequest>({ resolver: zodResolver(LoginRequest), defaultValues: { password: "" } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await login(values);
    } catch (error) {
      form.setError("password", { message: loginErrorMessage(error) });
      return;
    }
    // Fetch, not invalidate: the shell's guard reads the cache with ensureQueryData, which still holds `null`.
    await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    await navigate({ to: search.redirect ?? "/" });
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <Field data-invalid={errors.password ? true : undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            aria-invalid={errors.password ? true : undefined}
            {...form.register("password")}
          />
          <FieldError errors={[errors.password]} />
        </Field>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Logging in…" : "Log in"}
        </Button>
      </FieldGroup>
    </form>
  );
}

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "invalid_password") return "Wrong password.";
    if (error.code === "rate_limited") return "Too many attempts. Wait a minute and try again.";
    if (error.code === "login_disabled") return "Password login is off while Cloudflare Access is on.";
  }
  return "Could not log in. Try again.";
}
