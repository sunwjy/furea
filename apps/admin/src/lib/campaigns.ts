// The campaign resource as seen by the admin surface (ADR 0009, *Campaigns*).

import {
  Campaign,
  CampaignLinks,
  CampaignPage,
  UpdatedCampaign,
  type BulkCreateCampaignLinksRequest,
  type CreateCampaignRequest,
  type UpdateCampaignRequest,
} from "@furea/shared";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiJson, apiSend } from "./api.ts";

/** Every query under this key holds campaign data; invalidate it (and the links') after any campaign write. */
export const CAMPAIGNS_KEY = ["campaigns"] as const;

/** The campaign list: newest first, one page per "Load more"; `q` also serves the UTM campaign reuse warning. */
export function campaignListQuery(q = "") {
  return infiniteQueryOptions({
    queryKey: [...CAMPAIGNS_KEY, "list", q],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (q !== "") params.set("q", q);
      if (pageParam !== null) params.set("cursor", pageParam);
      const query = params.toString();
      return apiJson(`/campaigns${query === "" ? "" : `?${query}`}`, CampaignPage);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

const campaignPath = (id: string) => `/campaigns/${encodeURIComponent(id)}`;

export function campaignQuery(id: string) {
  return queryOptions({
    queryKey: [...CAMPAIGNS_KEY, "campaign", id],
    queryFn: () => apiJson(campaignPath(id), Campaign),
  });
}

/** Every member, oldest first, unpaginated (at most 50). */
export function campaignLinksQuery(id: string) {
  return queryOptions({
    queryKey: [...CAMPAIGNS_KEY, "links", id],
    queryFn: () => apiJson(`${campaignPath(id)}/links`, CampaignLinks),
  });
}

export const createCampaign = (body: CreateCampaignRequest) =>
  apiJson("/campaigns", Campaign, { method: "POST", body });

export const updateCampaign = (id: string, body: UpdateCampaignRequest) =>
  apiJson(campaignPath(id), UpdatedCampaign, { method: "PATCH", body });

/** Detaches every member; links are never deleted or disabled. */
export const deleteCampaign = (id: string) => apiSend(campaignPath(id), { method: "DELETE" });

/** All or nothing (ADR 0012). */
export const createCampaignLinks = (id: string, body: BulkCreateCampaignLinksRequest) =>
  apiJson(`${campaignPath(id)}/links`, CampaignLinks, { method: "POST", body });
