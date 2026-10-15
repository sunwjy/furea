// The link resource as seen by the admin surface (ADR 0009, *Link* and *Listing*).

import { Link, LinkPage, type CreateLinkRequest } from "@furea/shared";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { apiJson, apiSend } from "./api.ts";

/** Every query under this key holds link data; invalidate it after any link write. */
export const LINKS_KEY = ["links"] as const;

/** The feed: newest first, one page per "Load more". */
export function linkFeedQuery(q: string) {
  return infiniteQueryOptions({
    queryKey: [...LINKS_KEY, "feed", q],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (q !== "") params.set("q", q);
      if (pageParam !== null) params.set("cursor", pageParam);
      const query = params.toString();
      return apiJson(`/links${query === "" ? "" : `?${query}`}`, LinkPage);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

export const createLink = (body: CreateLinkRequest) => apiJson("/links", Link, { method: "POST", body });

export const deleteLink = (slug: string) => apiSend(`/links/${encodeURIComponent(slug)}`, { method: "DELETE" });
