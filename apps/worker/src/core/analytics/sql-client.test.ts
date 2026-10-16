import { describe, expect, it } from "vitest";
import { createSqlClient, sqlString } from "./sql-client.ts";

function recorder(response: Response) {
  const calls: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return response.clone();
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

describe("the Analytics Engine SQL client", () => {
  it("POSTs the statement as text to the account's SQL endpoint with the analytics token", async () => {
    const { calls, fetch } = recorder(Response.json({ meta: [], data: [], rows: 0 }));
    const client = createSqlClient({ accountId: "acc123", token: "tok-ro", fetch });

    await client.query("SELECT 1 AS one FORMAT JSON");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql");
    expect(call?.headers.get("authorization")).toBe("Bearer tok-ro");
    expect(await call?.text()).toBe("SELECT 1 AS one FORMAT JSON");
  });

  it("returns the data rows, with numbers sent as strings turned into numbers", async () => {
    const { fetch } = recorder(
      Response.json({
        meta: [
          { name: "country", type: "String" },
          { name: "clicks", type: "UInt64" },
        ],
        data: [
          { country: "KR", clicks: "12" },
          { country: "US", clicks: 3 },
        ],
        rows: 2,
      }),
    );
    const client = createSqlClient({ accountId: "a", token: "t", fetch });

    expect(await client.query("SELECT …")).toEqual([
      { country: "KR", clicks: 12 },
      { country: "US", clicks: 3 },
    ]);
  });

  it("throws on a refused query, naming the status", async () => {
    const { fetch } = recorder(new Response("SQL was excessively long", { status: 422 }));
    const client = createSqlClient({ accountId: "a", token: "t", fetch });

    await expect(client.query("SELECT …")).rejects.toThrow(/422/);
  });
});

describe("sqlString", () => {
  it("quotes a value as a SQL string literal, escaping backslashes and quotes", () => {
    expect(sqlString("Ab3xYz")).toBe("'Ab3xYz'");
    expect(sqlString("it's \\ odd")).toBe("'it\\'s \\\\ odd'");
  });
});
