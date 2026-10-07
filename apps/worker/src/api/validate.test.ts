import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toDetails } from "./validate.ts";

describe("toDetails", () => {
  const Schema = z.strictObject({
    items: z.array(
      z.strictObject({
        slug: z.string().refine((s) => s !== "admin", { message: "Reserved.", params: { code: "slug_reserved" } }),
      }),
    ),
  });

  it("names nested fields in the items[2].slug syntax and keeps a refinement's own code", () => {
    const result = Schema.safeParse({ items: [{ slug: "a" }, { slug: "b" }, { slug: "admin" }] });
    expect(toDetails(result.error as z.ZodError)).toEqual([
      { field: "items[2].slug", code: "slug_reserved", message: "Reserved." },
    ]);
  });

  it("reports one unknown_field entry per unknown key, at its own path", () => {
    const result = Schema.safeParse({ items: [{ slug: "a", extra: 1 }], other: true });
    expect(toDetails(result.error as z.ZodError).map(({ field, code }) => ({ field, code }))).toEqual([
      { field: "items[0].extra", code: "unknown_field" },
      { field: "other", code: "unknown_field" },
    ]);
  });

  it("falls back to the generic invalid code", () => {
    const result = Schema.safeParse({ items: "nope" });
    expect(toDetails(result.error as z.ZodError)).toEqual([
      { field: "items", code: "invalid", message: expect.any(String) },
    ]);
  });
});
