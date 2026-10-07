// Request-body validation over the `shared` zod schemas (ADR 0018): one middleware turns every way a body can
// be wrong into ADR 0009's envelope, so each route sees only a parsed value in `c.var.body`.

import type { ErrorDetail } from "@furea/shared";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import type { ApiEnv } from "./context.ts";
import { apiError } from "./errors.ts";

const MAX_BODY_BYTES = 64 * 1024;

export function jsonBody<S extends z.ZodType>(schema: S) {
  return createMiddleware<ApiEnv & { Variables: { body: z.infer<S> } }>(async (c, next) => {
    const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      return apiError(415, "unsupported_media_type", "Send the body as application/json.");
    }
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return apiError(413, "payload_too_large", "The body is larger than 64 KiB.");
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return apiError(400, "invalid_json", "The body is not valid JSON.");
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      return apiError(400, "validation_failed", "The request is invalid.", { details: toDetails(result.error) });
    }
    c.set("body", result.data);
    await next();
  });
}

/** One entry per failing field. A schema names its own field code with `params: {code}` on a refinement. */
export function toDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue): ErrorDetail[] => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        field: fieldName([...issue.path, key]),
        code: "unknown_field",
        message: `Unknown field "${key}".`,
      }));
    }
    const code = issue.code === "custom" && typeof issue.params?.["code"] === "string" ? issue.params["code"] : "invalid";
    return [{ field: fieldName(issue.path), code, message: issue.message }];
  });
}

/** `items[2].slug`, the field syntax of ADR 0009. */
function fieldName(path: readonly PropertyKey[]): string {
  return path.reduce<string>((name, part) => {
    if (typeof part === "number") return `${name}[${part}]`;
    return name === "" ? String(part) : `${name}.${String(part)}`;
  }, "");
}
