// The public API's one error envelope (ADR 0009). Every error response the API sends is built here.

import type { ErrorDetail, ErrorEnvelope } from "@furea/shared";

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503;

export function apiError(
  status: ErrorStatus,
  code: string,
  message: string,
  options: { details?: ErrorDetail[]; headers?: Record<string, string> } = {},
): Response {
  const body: ErrorEnvelope = { error: { code, message, ...(options.details ? { details: options.details } : {}) } };
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...options.headers } });
}

export const unauthorized = () => apiError(401, "unauthorized", "Authentication required.");
export const notFound = () => apiError(404, "not_found", "Not found.");
