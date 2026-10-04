// The Worker manifest, the only contract between the CLI and the Worker (ADR 0007). The Worker build writes it to
// apps/worker/dist/manifest.json; the published tarball carries it as dist/worker/manifest.json.

export interface RateLimitBinding {
  name: string;
  /** A positive integer as a string, fixed and reserved for furea (ADR 0003). */
  namespace_id: string;
  simple: { limit: number; period: 10 | 60 };
}

export interface WorkerManifest {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: {
    d1: string;
    kv: string;
    assets: string;
    /** Optional on the account: the installer drops it when Analytics Engine is not enabled (ADR 0006). */
    analytics_engine: { name: string; dataset: string };
    ratelimits: RateLimitBinding[];
    plain_text: string[];
    /** Secrets the Worker reads when present; never sent by `deploy` (`keep_bindings: ["secret_text"]`). */
    optional_secrets: string[];
  };
}
