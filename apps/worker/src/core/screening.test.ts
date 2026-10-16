import { describe, expect, it } from "vitest";
import { DOH_ENDPOINT, screenDestinations } from "./screening.ts";

type Answer = { Status: number; Answer?: { name: string; type: number; data: string }[]; Comment?: string[] };

const CLEAN: Answer = { Status: 0, Answer: [{ name: "example.com", type: 1, data: "93.184.215.14" }] };
const BLOCKED: Answer = {
  Status: 0,
  Answer: [{ name: "malware.testcategory.com", type: 1, data: "0.0.0.0" }],
  Comment: ["EDE(16): Censored"],
};

/** A canned DoH resolver: answers per queried name, records every request. */
function resolver(answers: Record<string, Answer | (() => Promise<Response>)>) {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const name = new URL(request.url).searchParams.get("name") ?? "";
    const answer = answers[name] ?? CLEAN;
    if (typeof answer === "function") return answer();
    return Response.json(answer, { headers: { "content-type": "application/dns-json" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const one = (url: string) => [{ field: "destination", url }];

describe("screenDestinations", () => {
  it("asks 1.1.1.1 for Families for the host's A record in the JSON form", async () => {
    const { fetch, requests } = resolver({});
    await screenDestinations(one("https://Example.com/path?q=1"), { fetch });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(DOH_ENDPOINT);
    expect(url.searchParams.get("name")).toBe("example.com");
    expect(url.searchParams.get("type")).toBe("A");
    expect(requests[0]!.headers.get("accept")).toBe("application/dns-json");
  });

  it("passes a clean host", async () => {
    const { fetch } = resolver({});
    expect(await screenDestinations(one("https://example.com/"), { fetch })).toEqual({ flagged: [], unavailable: false });
  });

  it("flags a host answered with 0.0.0.0 and EDE(16), naming the field and host", async () => {
    const { fetch } = resolver({ "malware.testcategory.com": BLOCKED });
    expect(await screenDestinations(one("https://malware.testcategory.com/x"), { fetch })).toEqual({
      flagged: [{ field: "destination", host: "malware.testcategory.com" }],
      unavailable: false,
    });
  });

  it("flags on EDE(16) alone, and on a 0.0.0.0 answer alone", async () => {
    const { fetch } = resolver({
      "ede.example": { Status: 0, Comment: ["EDE(16): Censored"] },
      "zero.example": { Status: 0, Answer: [{ name: "zero.example", type: 1, data: "0.0.0.0" }] },
    });
    const result = await screenDestinations(
      [
        { field: "a", url: "https://ede.example/" },
        { field: "b", url: "https://zero.example/" },
      ],
      { fetch },
    );
    expect(result.flagged).toEqual([
      { field: "a", host: "ede.example" },
      { field: "b", host: "zero.example" },
    ]);
  });

  it("passes NXDOMAIN and an empty answer", async () => {
    const { fetch } = resolver({
      "gone.example": { Status: 3 },
      "empty.example": { Status: 0 },
    });
    const result = await screenDestinations(
      [
        { field: "a", url: "https://gone.example/" },
        { field: "b", url: "https://empty.example/" },
      ],
      { fetch },
    );
    expect(result).toEqual({ flagged: [], unavailable: false });
  });

  it("does not look up IP-literal hosts", async () => {
    const { fetch, requests } = resolver({});
    const result = await screenDestinations(
      [
        { field: "a", url: "http://192.0.2.1/x" },
        { field: "b", url: "https://[2001:db8::1]/" },
      ],
      { fetch },
    );
    expect(result).toEqual({ flagged: [], unavailable: false });
    expect(requests).toHaveLength(0);
  });

  it("looks each distinct host up once, and reports every field that names a flagged host", async () => {
    const { fetch, requests } = resolver({ "bad.example": BLOCKED });
    const result = await screenDestinations(
      [
        { field: "a", url: "https://bad.example/1" },
        { field: "b", url: "https://BAD.example./2" },
        { field: "c", url: "https://good.example/" },
      ],
      { fetch },
    );
    expect(requests.map((r) => new URL(r.url).searchParams.get("name")).sort()).toEqual(["bad.example", "good.example"]);
    expect(result.flagged).toEqual([
      { field: "a", host: "bad.example" },
      { field: "b", host: "bad.example" },
    ]);
  });

  it("fails open on a non-2xx answer, a network error, a malformed body and a timeout", async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => new Response("busy", { status: 503 }),
      async () => {
        throw new TypeError("network down");
      },
      async () => new Response("not json", { status: 200 }),
    ];
    for (const answer of cases) {
      const { fetch } = resolver({ "x.example": answer });
      expect(await screenDestinations(one("https://x.example/"), { fetch })).toEqual({ flagged: [], unavailable: true });
    }

    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    expect(await screenDestinations(one("https://x.example/"), { fetch: hanging, timeoutMs: 20 })).toEqual({
      flagged: [],
      unavailable: true,
    });
  });

  it("fails open on a resolver error status (SERVFAIL, REFUSED)", async () => {
    for (const Status of [2, 5]) {
      const { fetch } = resolver({ "x.example": { Status } });
      expect(await screenDestinations(one("https://x.example/"), { fetch })).toEqual({ flagged: [], unavailable: true });
    }
  });

  it("still reports a flagged host when another host's lookup failed", async () => {
    const { fetch } = resolver({
      "bad.example": BLOCKED,
      "down.example": async () => new Response("", { status: 500 }),
    });
    const result = await screenDestinations(
      [
        { field: "a", url: "https://bad.example/" },
        { field: "b", url: "https://down.example/" },
      ],
      { fetch },
    );
    expect(result).toEqual({ flagged: [{ field: "a", host: "bad.example" }], unavailable: true });
  });
});
