// Recorded Cloudflare API fixtures (docs/testing.md, `packages/cli` Unit tier).
//
// Replay (default): `useFixture(scenario)` returns a `fetch` that answers from
// `test/fixtures/<scenario>.json` in order and fails on any request the recording does not have.
//
// Record (`FUREA_RECORD_FIXTURES=1`): the same call returns a `fetch` that hits the real API and,
// on `done()`, writes the ordered request/response pairs with the account id, token, resource ids,
// hostnames and e-mail addresses replaced by fixed placeholders. The test runs with the real values
// from the environment in that mode, and with the placeholders when replaying.

import { readFileSync, writeFileSync } from "node:fs";

export interface Interaction {
  request: { method: string; url: string; authorization?: string; body?: unknown };
  response: { status: number; body: unknown };
}

export interface Fixture {
  interactions: Interaction[];
}

export interface FixtureSecrets {
  /** Environment variable holding the real token when recording. */
  tokenEnv?: string;
  /** Environment variable holding the real account id when recording; unset means "not given". */
  accountEnv?: string;
  /** The scenario cannot be produced on a real account (a contrived API answer); it always replays. */
  replayOnly?: boolean;
}

export interface FixtureSession {
  fetch: typeof fetch;
  /** The real token when recording, its placeholder when replaying. */
  token: string;
  /** The real account id when recording, its placeholder when replaying (undefined when not given). */
  accountId: string | undefined;
  /** Replay: asserts every recorded request was made. Record: writes the fixture file. */
  done(): void;
}

export const ACCOUNT_PLACEHOLDER = "ACCOUNT_ID";

/** Keeps the `cfat_` prefix, because the CLI chooses the verify endpoint by it. */
export function tokenPlaceholder(token: string): string {
  return token.startsWith("cfat_") ? "cfat_TOKEN" : "TOKEN";
}

function fixturePath(scenario: string): URL {
  return new URL(`./fixtures/${scenario}.json`, import.meta.url);
}

export function useFixture(scenario: string, secrets: FixtureSecrets = {}): FixtureSession {
  const recording = process.env.FUREA_RECORD_FIXTURES === "1" && !secrets.replayOnly;
  if (!recording) {
    const fixture = JSON.parse(readFileSync(fixturePath(scenario), "utf8")) as Fixture & {
      token: string;
      accountId?: string;
    };
    const replay = replayFetch(fixture);
    return { fetch: replay.fetch, token: fixture.token, accountId: fixture.accountId, done: replay.done };
  }
  const token = process.env[secrets.tokenEnv ?? "CLOUDFLARE_API_TOKEN"];
  if (!token) throw new Error(`Recording ${scenario} needs ${secrets.tokenEnv ?? "CLOUDFLARE_API_TOKEN"}.`);
  const accountId = secrets.accountEnv ? process.env[secrets.accountEnv] : undefined;
  const recorder = recordingFetch(globalThis.fetch);
  return {
    fetch: recorder.fetch,
    token,
    accountId,
    done() {
      const known: Array<[string, string]> = [[token, tokenPlaceholder(token)]];
      if (accountId) known.push([accountId, ACCOUNT_PLACEHOLDER]);
      const fixture = sanitize({ interactions: recorder.interactions }, known);
      const header = { token: tokenPlaceholder(token), ...(accountId ? { accountId: ACCOUNT_PLACEHOLDER } : {}) };
      writeFileSync(fixturePath(scenario), `${JSON.stringify({ ...header, ...fixture }, null, 2)}\n`);
    },
  };
}

function authorizationOf(init: RequestInit | undefined): string | undefined {
  const value = new Headers(init?.headers).get("authorization");
  return value ?? undefined;
}

function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return undefined;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

export function replayFetch(fixture: Fixture): { fetch: typeof fetch; done(): void } {
  let next = 0;
  const replay = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input instanceof Request ? input.url : input);
    const expected = fixture.interactions[next];
    if (!expected) throw new Error(`Unrecorded request #${next + 1}: ${method} ${url}`);
    const got = { method, url, authorization: authorizationOf(init) };
    const want = { method: expected.request.method, url: expected.request.url, authorization: expected.request.authorization };
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`Request #${next + 1} differs from the recording:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
    next++;
    return new Response(JSON.stringify(expected.response.body), {
      status: expected.response.status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch: replay as typeof fetch,
    done() {
      if (next !== fixture.interactions.length) {
        throw new Error(`Only ${next} of ${fixture.interactions.length} recorded requests were made.`);
      }
    },
  };
}

export function recordingFetch(upstream: typeof fetch): { fetch: typeof fetch; interactions: Interaction[] } {
  const interactions: Interaction[] = [];
  const record = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await upstream(input, init);
    const text = await response.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Keep non-JSON bodies verbatim.
    }
    const authorization = authorizationOf(init);
    const requestBody = bodyOf(init);
    interactions.push({
      request: {
        method: (init?.method ?? "GET").toUpperCase(),
        url: String(input instanceof Request ? input.url : input),
        ...(authorization ? { authorization } : {}),
        ...(requestBody === undefined ? {} : { body: requestBody }),
      },
      response: { status: response.status, body },
    });
    return response;
  };
  return { fetch: record as typeof fetch, interactions };
}

// Keys whose string values identify the account or its resources. Their values are replaced
// everywhere in the fixture (URLs included), numbered in order of first appearance.
const IDENTIFYING_KEYS: Record<string, string> = {
  id: "ID",
  uuid: "ID",
  account_id: "ID",
  zone_id: "ID",
  script_id: "ID",
  hostname: "HOST",
  zone_name: "HOST",
  subdomain: "SUBDOMAIN",
  // Asset upload and completion tokens; they also appear as the bearer of the upload requests.
  jwt: "JWT",
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Replaces known secrets, then every identifying value, across the whole fixture. */
export function sanitize(fixture: Fixture, known: Array<[string, string]>): Fixture {
  const replacements = new Map<string, string>(known);
  const counters = new Map<string, number>();
  const placeholders = new Set(known.map(([, placeholder]) => placeholder));
  const name = (label: string): string => {
    const n = (counters.get(label) ?? 0) + 1;
    counters.set(label, n);
    if (label === "HOST") return `host-${n}.example.com`;
    if (label === ACCOUNT_PLACEHOLDER) return n === 1 ? ACCOUNT_PLACEHOLDER : `${ACCOUNT_PLACEHOLDER}_${n}`;
    return `${label}_${n}`;
  };
  // In an account listing, `id` is an account id.
  const collect = (value: unknown, idLabel: string): void => {
    if (Array.isArray(value)) value.forEach((item) => collect(item, idLabel));
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        const label = key === "id" ? idLabel : IDENTIFYING_KEYS[key];
        if (label && typeof inner === "string" && inner !== "" && !replacements.has(inner) && !placeholders.has(inner)) {
          replacements.set(inner, name(label));
        }
        collect(inner, idLabel);
      }
    }
  };
  if (known.some(([, placeholder]) => placeholder === ACCOUNT_PLACEHOLDER)) counters.set(ACCOUNT_PLACEHOLDER, 1);
  for (const { request, response } of fixture.interactions) {
    const listing = new URL(request.url).pathname.endsWith("/accounts");
    collect(response.body, listing ? ACCOUNT_PLACEHOLDER : "ID");
  }
  let text = JSON.stringify(fixture);
  // Longest first, so a value that contains another is replaced whole; only whole words, so a short id
  // cannot eat into a path segment that merely contains it.
  for (const [real, placeholder] of [...replacements].sort((a, b) => b[0].length - a[0].length)) {
    const escaped = real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g"), placeholder);
  }
  return JSON.parse(text.replace(EMAIL, "operator@example.com")) as Fixture;
}
