import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as links from "./links.ts";

// A printed link is the whole instruction (ADR 0006), so every docs page the CLI links to must exist on `main`.
const REPO_BLOB = "https://github.com/sunwjy/furea/blob/main/";
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("docs links the CLI prints", () => {
  const entries = Object.entries(links);

  it("exports at least one link", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)("%s points at a file in this repository", (_name, url) => {
    expect(url).toMatch(new RegExp(`^${REPO_BLOB.replaceAll(".", "\\.")}`));
    const path = String(url).slice(REPO_BLOB.length).split("#")[0];
    expect(existsSync(`${REPO_ROOT}${path}`), `${path} is missing`).toBe(true);
  });
});
