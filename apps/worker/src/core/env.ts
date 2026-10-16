export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  /** Absent when Analytics Engine is not enabled on the account (ADR 0006). */
  CLICKS?: AnalyticsEngineDataset;
  LOGIN_IP_LIMITER: RateLimit;
  LOGIN_GLOBAL_LIMITER: RateLimit;
  FUREA_VERSION: string;
  /** The read-only analytics token (ADR 0005); breakdowns are unavailable without it. */
  ANALYTICS_TOKEN?: string;
  /** The account the Analytics Engine SQL API is called for; written by the installer with the script. */
  FUREA_ACCOUNT_ID?: string;
}
