// The Workers Analytics Engine SQL API client (ADR 0005). `fetch` is injected so tests replay canned responses and
// nothing here ever reaches Cloudflare from a test.

const API = "https://api.cloudflare.com/client/v4";

export type SqlRow = Record<string, string | number>;

export interface SqlClient {
  /** Runs one statement (one read query) and returns its rows. */
  query(sql: string): Promise<SqlRow[]>;
}

export interface SqlClientOptions {
  accountId: string;
  /** The read-only `ANALYTICS_TOKEN` (Account Analytics Read), never the deploy token. */
  token: string;
  fetch: typeof globalThis.fetch;
}

/** Numeric ClickHouse types (UInt64 and friends) arrive as JSON strings. */
const NUMERIC_TYPE = /^(U?Int|Float|Decimal)/;

interface SqlResponse {
  meta?: { name: string; type: string }[];
  data?: Record<string, unknown>[];
}

export function createSqlClient({ accountId, token, fetch }: SqlClientOptions): SqlClient {
  return {
    async query(sql) {
      const res = await fetch(`${API}/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
        body: sql,
      });
      if (!res.ok) throw new Error(`Analytics Engine SQL API answered ${res.status}`);
      const body = (await res.json()) as SqlResponse;
      const numeric = new Set((body.meta ?? []).filter((m) => NUMERIC_TYPE.test(m.type)).map((m) => m.name));
      return (body.data ?? []).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            numeric.has(key) || typeof value === "number" ? Number(value) : String(value),
          ]),
        ),
      );
    },
  };
}

/** A SQL string literal. The SQL API has no bound parameters, so every value goes through here. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
