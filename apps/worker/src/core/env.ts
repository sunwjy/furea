export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  /** Absent when Analytics Engine is not enabled on the account (ADR 0006). */
  CLICKS?: AnalyticsEngineDataset;
  LOGIN_IP_LIMITER: RateLimit;
  LOGIN_GLOBAL_LIMITER: RateLimit;
  FUREA_VERSION: string;
  ANALYTICS_TOKEN?: string;
}
