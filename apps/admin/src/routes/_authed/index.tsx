import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/")({
  component: LinksPage,
});

function LinksPage() {
  return <h1 className="font-heading text-xl font-semibold">Links</h1>;
}
