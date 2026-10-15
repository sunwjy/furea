// The link resource as seen by the admin surface (ADR 0009, *Link* and *Listing*).

import { Link, LinkPage, type CreateLinkRequest, type UpdateLinkRequest } from "@furea/shared";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
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

/** One link, for its own page. */
export function linkQuery(slug: string) {
  return queryOptions({
    queryKey: [...LINKS_KEY, "link", slug],
    queryFn: () => apiJson(linkPath(slug), Link),
  });
}

/** Every link query except the link pages': the ones to refetch after a write that returns the link itself. */
export const isLinkListQuery = (query: { queryKey: readonly unknown[] }) => query.queryKey[1] !== "link";

const linkPath = (slug: string) => `/links/${encodeURIComponent(slug)}`;

export const createLink = (body: CreateLinkRequest) => apiJson("/links", Link, { method: "POST", body });

/** A merge-patch; `{}` only rewrites the redirect cache entry, which is what *Retry now* sends (ADR 0009). */
export const updateLink = (slug: string, body: UpdateLinkRequest) =>
  apiJson(linkPath(slug), Link, { method: "PATCH", body });

export const deleteLink = (slug: string) => apiSend(linkPath(slug), { method: "DELETE" });
