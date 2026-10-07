import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./lib/api.ts";
import { routeTree } from "./routeTree.gen.ts";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    // A 4xx answer will not change on retry; only network failures and 5xx are worth another try.
    queries: { retry: (count, error) => count < 3 && !(error instanceof ApiError && error.status < 500) },
  },
});

const router = createRouter({
  routeTree,
  basepath: "/admin",
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
