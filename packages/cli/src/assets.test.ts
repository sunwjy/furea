import { describe, expect, it } from "vitest";
import { assetHash } from "./assets.ts";

describe("asset hashes", () => {
  // Expected values computed with wrangler's own hasher (blake3-wasm over base64 contents + extension, first
  // 32 hex characters), so an asset set uploaded by furea dedupes against one uploaded by wrangler or `cf`.
  it.each([
    ["admin/index.html", "<!doctype html><title>furea</title>\n", "0ab3e2323548d4413aa042fcbafe2b2e"],
    ["admin/app.css", "body{}", "622e1fa69535c6ed5e3a85e2ccaafd15"],
    ["favicon.ico", "", "6b3a9496db768f6b40fd7f398e5c851d"],
  ])("matches wrangler for %s", (path, contents, expected) => {
    expect(assetHash(path, new TextEncoder().encode(contents))).toBe(expected);
  });
});
