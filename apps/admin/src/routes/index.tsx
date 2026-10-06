import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="p-6">
      <h1 className="font-heading text-xl font-semibold">furea</h1>
    </main>
  );
}
