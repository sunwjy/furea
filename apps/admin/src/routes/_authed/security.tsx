import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/security")({
  component: SecurityPage,
});

function SecurityPage() {
  return <h1 className="font-heading text-xl font-semibold">Security</h1>;
}
