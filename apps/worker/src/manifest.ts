import type { WorkerManifest } from "@furea/shared";

/**
 * What the Worker bundle expects from its deployment (ADR 0007). The build writes it to dist/manifest.json;
 * the CLI reads it to build the upload metadata. Keep in step with wrangler.jsonc (src/manifest.test.ts).
 */
export function buildManifest(): WorkerManifest {
  return {
    main_module: "index.js",
    compatibility_date: "2026-09-28",
    compatibility_flags: [],
    bindings: {
      d1: "DB",
      kv: "KV",
      assets: "ASSETS",
      analytics_engine: { name: "CLICKS", dataset: "furea_clicks" },
      ratelimits: [
        { name: "LOGIN_IP_LIMITER", namespace_id: "730016001", simple: { limit: 5, period: 60 } },
        { name: "LOGIN_GLOBAL_LIMITER", namespace_id: "730016002", simple: { limit: 30, period: 60 } },
      ],
      plain_text: ["FUREA_VERSION"],
      optional_secrets: ["ANALYTICS_TOKEN"],
    },
  };
}
