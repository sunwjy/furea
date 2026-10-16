// A canned 1.1.1.1 for Families resolver for the Workers pool (docs/testing.md): the setup file puts it in front of
// the global `fetch`, so no test reaches the real resolver. Every other request passes through untouched.

import { DOH_ENDPOINT } from "../src/core/screening.ts";

const flagged = new Set<string>();
const lookups: string[] = [];
let down = false;

export const doh = {
  /** The resolver answers `0.0.0.0` with EDE(16) for this host from now on. */
  flag(host: string) {
    flagged.add(host);
  },
  /** Every lookup answers 503 from now on. */
  goDown() {
    down = true;
  },
  /** Hosts looked up since the last reset, in order. */
  lookups: lookups as readonly string[],
  reset() {
    flagged.clear();
    lookups.length = 0;
    down = false;
  },
};

export function installDoh(): void {
  const passThrough = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(`${DOH_ENDPOINT}?`)) return passThrough(input, init);
    const name = new URL(request.url).searchParams.get("name") ?? "";
    lookups.push(name);
    if (down) return new Response("unavailable", { status: 503 });
    const body = flagged.has(name)
      ? { Status: 0, Answer: [{ name, type: 1, data: "0.0.0.0" }], Comment: ["EDE(16): Censored"] }
      : { Status: 0, Answer: [{ name, type: 1, data: "192.0.2.10" }] };
    return Response.json(body, { headers: { "content-type": "application/dns-json" } });
  };
}
