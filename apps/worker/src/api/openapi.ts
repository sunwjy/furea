// The OpenAPI 3.1 document of `GET /api/v1/openapi.json` (ADR 0009, ADR 0018): the `shared` zod schemas converted
// with `z.toJSONSchema()`, placed into a hand-written list of operations. Adding an endpoint adds one entry here.

import {
  ApiKey,
  ApiKeyList,
  BulkCreateCampaignLinksRequest,
  Campaign,
  CampaignLinks,
  CampaignPage,
  CampaignStats,
  ChangePasswordRequest,
  CreateCampaignRequest,
  CreateApiKeyRequest,
  CreatedApiKey,
  CreateLinkRequest,
  ErrorDetail,
  ErrorEnvelope,
  InstanceStats,
  Link,
  LinkPage,
  LinkStats,
  ListCampaignsQuery,
  ListLinksQuery,
  LoginMethodResponse,
  LoginRequest,
  SessionResponse,
  Settings,
  StatsQuery,
  UpdateCampaignRequest,
  UpdatedCampaign,
  UpdateLinkRequest,
  UpdateSettingsRequest,
} from "@furea/shared";
import { z } from "zod";
import { SESSION_COOKIE } from "./session.ts";

type JsonSchema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** Converts a set of named schemas, cross-referencing each other by name instead of inlining. */
function components(io: "input" | "output", schemas: Record<string, z.ZodType>): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(schemas)) registry.add(schema, { id });
  const { schemas: converted } = z.toJSONSchema(registry, {
    io,
    uri: (id) => ref(id).$ref,
    // Responses only ever gain fields within v1 (ADR 0009), so a client must not be told they are closed.
    override: ({ jsonSchema }) => {
      if (io === "output" && jsonSchema.additionalProperties === false) delete jsonSchema.additionalProperties;
    },
  }) as { schemas: Record<string, JsonSchema> };
  // `$schema` and `$id` belong to standalone JSON Schema documents, not to OpenAPI components.
  for (const schema of Object.values(converted)) {
    delete schema["$schema"];
    delete schema["$id"];
  }
  return converted;
}

/** Query parameters from an object schema's input shape. */
function queryParameters(schema: z.ZodObject): JsonSchema[] {
  const { properties = {}, required = [] } = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.includes(name),
    schema: property,
  }));
}

const SLUG_PARAMETER = { name: "slug", in: "path", required: true, schema: { type: "string" } };
const CAMPAIGN_ID_PARAMETER = { name: "id", in: "path", required: true, schema: { type: "string" } };

const json = (schema: JsonSchema) => ({ content: { "application/json": { schema } } });

function errors(...statuses: number[]): Record<string, JsonSchema> {
  return Object.fromEntries(statuses.map((status) => [String(status), { $ref: "#/components/responses/Error" }]));
}

const BODY_ERRORS = [400, 413, 415] as const;

interface Operation {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  summary: string;
  /** `true` for the endpoints anyone may call. */
  public?: true;
  /** `true` for the endpoints an API key may never call (ADR 0009, *Who may call what*). */
  sessionOnly?: true;
  parameters?: JsonSchema[];
  body?: string;
  success: { status: number; description: string; schema?: string };
  errors: readonly number[];
}

const OPERATIONS: Operation[] = [
  {
    method: "get",
    path: "/auth/login",
    summary: "Which login door is open: the operator password or Cloudflare Access.",
    public: true,
    success: { status: 200, description: "The open door.", schema: "LoginMethodResponse" },
    errors: [],
  },
  {
    method: "post",
    path: "/auth/login",
    summary: "Log in with the operator password; sets the session cookie.",
    public: true,
    body: "LoginRequest",
    success: { status: 204, description: "Logged in; the session cookie is set." },
    errors: [...BODY_ERRORS, 401, 403, 429],
  },
  {
    method: "post",
    path: "/auth/logout",
    summary: "End this browser session. Session only.",
    sessionOnly: true,
    success: { status: 204, description: "Logged out; the session cookie is cleared." },
    errors: [401, 403],
  },
  {
    method: "get",
    path: "/auth/session",
    summary: "Who the caller is.",
    success: { status: 200, description: "The caller.", schema: "SessionResponse" },
    errors: [401],
  },
  {
    method: "get",
    path: "/api-keys",
    summary: "List every API key, newest first, without the key itself. Session only.",
    sessionOnly: true,
    success: { status: 200, description: "Every API key.", schema: "ApiKeyList" },
    errors: [401, 403],
  },
  {
    method: "post",
    path: "/api-keys",
    summary: "Create an API key. The answer carries the key itself this once. Session only.",
    sessionOnly: true,
    body: "CreateApiKeyRequest",
    success: { status: 201, description: "The created key, with the key itself.", schema: "CreatedApiKey" },
    errors: [...BODY_ERRORS, 401, 403],
  },
  {
    method: "delete",
    path: "/api-keys/{id}",
    summary: "Revoke an API key; it stops working on the next request. Session only.",
    sessionOnly: true,
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    success: { status: 204, description: "Revoked." },
    errors: [401, 403, 404],
  },
  {
    method: "post",
    path: "/links",
    summary:
      "Create a link, with a custom slug or a generated one. The destination's host is screened (422 " +
      "destination_flagged); a session may send screening: \"skip\" to save it anyway.",
    body: "CreateLinkRequest",
    success: { status: 201, description: "The created link.", schema: "Link" },
    errors: [...BODY_ERRORS, 401, 403, 409, 422],
  },
  {
    method: "get",
    path: "/links",
    summary: "List links, newest first (createdAt desc, slug desc), cursor-paginated.",
    parameters: queryParameters(ListLinksQuery),
    success: { status: 200, description: "One page of links.", schema: "LinkPage" },
    errors: [400, 401],
  },
  {
    method: "get",
    path: "/links/{slug}",
    summary: "Read one link.",
    parameters: [SLUG_PARAMETER],
    success: { status: 200, description: "The link.", schema: "Link" },
    errors: [401, 404],
  },
  {
    method: "patch",
    path: "/links/{slug}",
    summary:
      "Edit a link as a merge-patch: destination, title (null clears it), enabled. An empty {} still rewrites the " +
      "redirect cache entry. A destination is screened like on creation. campaign: null detaches the link; " +
      "campaign: {id} adopts a plain link whose destination already matches the campaign (409 adopt_mismatch with " +
      "the reason code, campaign_member, campaign_link_limit).",
    parameters: [SLUG_PARAMETER],
    body: "UpdateLinkRequest",
    success: { status: 200, description: "The edited link.", schema: "Link" },
    errors: [...BODY_ERRORS, 401, 403, 404, 409, 422],
  },
  {
    method: "delete",
    path: "/links/{slug}",
    summary: "Delete a link for good; its slug becomes free.",
    parameters: [SLUG_PARAMETER],
    success: { status: 204, description: "Deleted." },
    errors: [401, 403, 404],
  },
  {
    method: "post",
    path: "/campaigns",
    summary:
      "Create a campaign. utmCampaign defaults to the trimmed name. The base URL follows the destination rules, " +
      "must carry no utm_* parameter (base_url_has_utm) and is screened (422 destination_flagged); a session may " +
      "send screening: \"skip\". 409 campaign_name_taken when another campaign has the name, ignoring case.",
    body: "CreateCampaignRequest",
    success: { status: 201, description: "The created campaign.", schema: "Campaign" },
    errors: [...BODY_ERRORS, 401, 403, 409, 422],
  },
  {
    method: "get",
    path: "/campaigns",
    summary:
      "List campaigns, newest first (createdAt desc, id desc), cursor-paginated; q matches the name and the UTM " +
      "campaign. The aggregates are computed from the links.",
    parameters: queryParameters(ListCampaignsQuery),
    success: { status: 200, description: "One page of campaigns.", schema: "CampaignPage" },
    errors: [400, 401],
  },
  {
    method: "get",
    path: "/campaigns/{id}",
    summary: "Read one campaign.",
    parameters: [CAMPAIGN_ID_PARAMETER],
    success: { status: 200, description: "The campaign.", schema: "Campaign" },
    errors: [401, 404],
  },
  {
    method: "patch",
    path: "/campaigns/{id}",
    summary:
      "Edit a campaign as a merge-patch: name. The aggregates are read-only. 409 campaign_name_taken when another " +
      "campaign has the name, ignoring case.",
    parameters: [CAMPAIGN_ID_PARAMETER],
    body: "UpdateCampaignRequest",
    success: { status: 200, description: "The edited campaign.", schema: "UpdatedCampaign" },
    errors: [...BODY_ERRORS, 401, 403, 404, 409],
  },
  {
    method: "delete",
    path: "/campaigns/{id}",
    summary: "Delete a campaign. Its links are detached, never deleted or disabled.",
    parameters: [CAMPAIGN_ID_PARAMETER],
    success: { status: 204, description: "Deleted; its links are plain links now." },
    errors: [401, 403, 404],
  },
  {
    method: "get",
    path: "/campaigns/{id}/links",
    summary: "Every link of the campaign, oldest first (createdAt asc, slug asc), unpaginated.",
    parameters: [CAMPAIGN_ID_PARAMETER],
    success: { status: 200, description: "The campaign's links.", schema: "CampaignLinks" },
    errors: [401, 404],
  },
  {
    method: "post",
    path: "/campaigns/{id}/links",
    summary:
      "Create links in the campaign, all or nothing; the only way to create a campaign link. Each destination is " +
      "composed from the campaign and the item's utm. Every failing item is reported in one 400 " +
      "validation_failed (slug_taken, utm_combination_taken with conflictsWith, destination_invalid); 409 " +
      "campaign_link_limit past 50 links; the base URL's host is screened once (422 destination_flagged).",
    parameters: [CAMPAIGN_ID_PARAMETER],
    body: "BulkCreateCampaignLinksRequest",
    success: { status: 201, description: "The created links, in request order.", schema: "CampaignLinks" },
    errors: [...BODY_ERRORS, 401, 403, 404, 409, 422],
  },
  {
    method: "get",
    path: "/settings",
    summary: "The instance settings: the root destination, Access mode and read-only instance facts.",
    success: { status: 200, description: "The settings.", schema: "Settings" },
    errors: [401],
  },
  {
    method: "patch",
    path: "/settings",
    summary:
      "Edit the settings as a merge-patch. rootDestination: null unsets it. analyticsConfigured and version are " +
      "read-only. An empty {} still rewrites the root destination's redirect cache entry. A rootDestination is " +
      "screened like a link's destination. access is session only: turning Access mode on is refused on a " +
      "workers.dev host (access_requires_own_domain) and when the team's public keys cannot be fetched " +
      "(access_unreachable); access: null turns it off from any host.",
    body: "UpdateSettingsRequest",
    success: { status: 200, description: "The settings after the edit.", schema: "Settings" },
    errors: [...BODY_ERRORS, 401, 403, 409, 422],
  },
  {
    method: "post",
    path: "/password",
    summary: "Change the operator password after re-entering the current one; ends every session. Session only.",
    sessionOnly: true,
    body: "ChangePasswordRequest",
    success: { status: 204, description: "Changed; every session is ended and this one's cookie cleared." },
    errors: [...BODY_ERRORS, 401, 403],
  },
  {
    method: "get",
    path: "/links/{slug}/stats",
    summary:
      "A link's click breakdowns for the range: series (hourly for 24h, daily otherwise, zero-filled), top 10 " +
      "countries, top 10 referrer hosts and device classes. Last 90 days, estimated. 503 analytics_unavailable " +
      "when breakdowns are not configured, naming what is missing.",
    parameters: [SLUG_PARAMETER, ...queryParameters(StatsQuery)],
    success: { status: 200, description: "The link's breakdowns.", schema: "LinkStats" },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/stats",
    summary:
      "The instance overview: clicks today, in the last 7 and 30 days, the top 10 links for the range and a " +
      "series per link with a click in the range. Last 90 days, estimated. 503 analytics_unavailable when " +
      "breakdowns are not configured.",
    parameters: queryParameters(StatsQuery),
    success: { status: 200, description: "The overview.", schema: "InstanceStats" },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/campaigns/{id}/stats",
    summary:
      "A campaign's click breakdowns over its current members, read at query time: the combined series and top " +
      "lists shaped like a link's, and bySlug with every current member's range clicks and series, zero-filled. " +
      "Last 90 days, estimated. 503 analytics_unavailable when breakdowns are not configured.",
    parameters: [CAMPAIGN_ID_PARAMETER, ...queryParameters(StatsQuery)],
    success: { status: 200, description: "The campaign's breakdowns.", schema: "CampaignStats" },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/openapi.json",
    summary: "This document.",
    public: true,
    success: { status: 200, description: "The OpenAPI 3.1 document." },
    errors: [],
  },
];

function operationObject(op: Operation): JsonSchema {
  const success = {
    description: op.success.description,
    ...(op.success.schema ? json(ref(op.success.schema)) : {}),
  };
  return {
    summary: op.summary,
    ...(op.public ? { security: [] } : op.sessionOnly ? { security: [{ session: [] }] } : {}),
    ...(op.parameters ? { parameters: op.parameters } : {}),
    ...(op.body ? { requestBody: { required: true, ...json(ref(op.body)) } } : {}),
    responses: { [String(op.success.status)]: success, ...errors(...op.errors) },
  };
}

export function buildOpenApiDocument(version: string): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const op of OPERATIONS) (paths[op.path] ??= {})[op.method] = operationObject(op);

  return {
    openapi: "3.1.0",
    info: { title: "furea public API", version },
    servers: [{ url: "/api/v1" }],
    security: [{ session: [] }, { apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE },
        apiKey: { type: "http", scheme: "bearer", description: "An API key, furea_…; read or write scope." },
      },
      schemas: {
        ...components("input", {
          BulkCreateCampaignLinksRequest,
          ChangePasswordRequest,
          CreateApiKeyRequest,
          CreateCampaignRequest,
          CreateLinkRequest,
          LoginRequest,
          UpdateCampaignRequest,
          UpdateLinkRequest,
          UpdateSettingsRequest,
        }),
        ...components("output", {
          ApiKey,
          ApiKeyList,
          Campaign,
          CampaignLinks,
          CampaignPage,
          CampaignStats,
          CreatedApiKey,
          ErrorDetail,
          ErrorEnvelope,
          InstanceStats,
          Link,
          LinkPage,
          LinkStats,
          LoginMethodResponse,
          SessionResponse,
          Settings,
          UpdatedCampaign,
        }),
      },
      responses: {
        Error: {
          description: "Any failure: the error envelope, with per-field details on validation_failed.",
          ...json(ref("ErrorEnvelope")),
        },
      },
    },
  };
}
