// The one error envelope of the public API (ADR 0009): `{"error": {code, message, details?}}`.

import { z } from "zod";

export const ErrorDetail = z.looseObject({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});
export type ErrorDetail = z.infer<typeof ErrorDetail>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(ErrorDetail).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
