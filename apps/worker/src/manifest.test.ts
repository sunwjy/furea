import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import wranglerSource from "../wrangler.jsonc?raw";
import { buildManifest } from "./manifest.ts";

interface WranglerConfig {
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  assets: { binding: string; not_found_handling: string };
  d1_databases: { binding: string }[];
  kv_namespaces: { binding: string }[];
  analytics_engine_datasets: { binding: string; dataset: string }[];
  ratelimits: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
  vars: Record<string, string>;
}

const wrangler = parse(wranglerSource) as WranglerConfig;
const manifest = buildManifest();

describe("buildManifest() and the dev-only wrangler.jsonc", () => {
  it("agree on compatibility date and flags", () => {
    expect(manifest.compatibility_date).toBe(wrangler.compatibility_date);
    expect(manifest.compatibility_flags).toEqual(wrangler.compatibility_flags);
  });

  it("agree on every binding name", () => {
    expect(manifest.bindings.d1).toBe(wrangler.d1_databases[0]?.binding);
    expect(wrangler.d1_databases).toHaveLength(1);
    expect(manifest.bindings.kv).toBe(wrangler.kv_namespaces[0]?.binding);
    expect(wrangler.kv_namespaces).toHaveLength(1);
    expect(manifest.bindings.assets).toBe(wrangler.assets.binding);
    expect([manifest.bindings.analytics_engine]).toEqual(
      wrangler.analytics_engine_datasets.map(({ binding, dataset }) => ({ name: binding, dataset })),
    );
    expect(manifest.bindings.ratelimits).toEqual(wrangler.ratelimits);
    expect(manifest.bindings.plain_text).toEqual(Object.keys(wrangler.vars));
  });

  it("names the bundle's main module", () => {
    expect(manifest.main_module).toBe("index.js");
  });

  it("serves assets first without the SPA fallback (ADR 0001)", () => {
    expect(wrangler.assets.not_found_handling).toBe("none");
    expect(wrangler).not.toHaveProperty("assets.run_worker_first");
  });
});
