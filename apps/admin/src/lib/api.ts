// The admin surface's API client (ADR 0017): a small fetch wrapper that parses responses with the `shared` zod
// schemas and turns ADR 0009's error envelope into an ApiError. Same origin, so the session cookie rides along.

import { ErrorEnvelope, type ErrorDetail } from "@furea/shared";
import type { z } from "zod";

const BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[];

  constructor(status: number, code: string, message: string, details: ErrorDetail[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

/** A request whose success has no body (204). */
export async function apiSend(path: string, options: RequestOptions = {}): Promise<void> {
  await request(path, options);
}

/** A request whose success body is parsed with `schema`. */
export async function apiJson<S extends z.ZodType>(path: string, schema: S, options: RequestOptions = {}): Promise<z.infer<S>> {
  const res = await request(path, options);
  return schema.parse(await res.json());
}

async function request(path: string, { method = "GET", body }: RequestOptions): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.ok) return res;
  const envelope = ErrorEnvelope.safeParse(await res.json().catch(() => null));
  if (!envelope.success) throw new ApiError(res.status, "internal", `Unexpected ${res.status} response.`);
  const { code, message, details } = envelope.data.error;
  throw new ApiError(res.status, code, message, details);
}
