import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return <h1 className="font-heading text-xl font-semibold">Settings</h1>;
}
