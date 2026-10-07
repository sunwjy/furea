import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { logout, sessionQuery } from "@/lib/auth";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    if ((await context.queryClient.ensureQueryData(sessionQuery)) === null) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: Shell,
});

const NAV = [
  { to: "/", label: "Links" },
  { to: "/campaigns", label: "Campaigns" },
  { to: "/security", label: "Security" },
  { to: "/settings", label: "Settings" },
] as const;

function Shell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function onLogout() {
    try {
      await logout();
    } catch {
      toast.error("Could not log out. Try again.");
      return;
    }
    queryClient.clear();
    await navigate({ to: "/login" });
  }

  return (
    <div className="min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <span className="font-heading font-semibold">furea</span>
          <nav aria-label="Main" className="flex gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: true }}
                className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
                activeProps={{ className: "bg-muted text-foreground" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onLogout}>
            <LogOut data-icon="inline-start" />
            Log out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
