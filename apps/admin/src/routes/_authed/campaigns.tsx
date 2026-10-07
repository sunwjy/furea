import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/campaigns")({
  component: CampaignsPage,
});

function CampaignsPage() {
  return <h1 className="font-heading text-xl font-semibold">Campaigns</h1>;
}
