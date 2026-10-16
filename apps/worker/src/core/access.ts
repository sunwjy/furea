// Cloudflare Access mode (ADR 0003): the Worker verifies the Access JWT itself, against the team's public keys at
// https://<team>/cdn-cgi/access/certs. The keys are cached per isolate; an unknown `kid` (a key rotation) refetches
// them, at most once per REFETCH_MS, so a stream of forged tokens cannot turn into a stream of subrequests.

import { getAccessConfig } from "./db/settings.ts";

export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

export interface AccessIdentity {
  email: string | null;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
/** Cloudflare rotates the signing keys every six weeks and keeps the previous one valid for a week after. */
const CACHE_MS = 60 * 60 * 1000;
const REFETCH_MS = 30 * 1000;
/** Tolerated clock difference between the Access edge and this isolate. */
const LEEWAY_SECONDS = 60;

export const certsUrl = (teamDomain: string) => `https://${teamDomain}/cdn-cgi/access/certs`;

export interface AccessVerifier {
  /** Fetches the team's keys afresh; `false` when they cannot be fetched or hold no usable key. */
  keysReachable(teamDomain: string): Promise<boolean>;
  /** The identity in a valid JWT for this application, or `null` for anything else. */
  verify(token: string, config: AccessConfig): Promise<AccessIdentity | null>;
}

export function createAccessVerifier(options: { fetch: typeof fetch; now?: () => number }): AccessVerifier {
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedKeys>();

  async function load(teamDomain: string): Promise<CachedKeys | null> {
    const keys = await fetchKeys(options.fetch, teamDomain);
    if (keys === null) return null;
    const entry = { keys, fetchedAt: now() };
    cache.set(teamDomain, entry);
    return entry;
  }

  async function keyFor(teamDomain: string, kid: string): Promise<CryptoKey | null> {
    let entry = cache.get(teamDomain);
    if (entry === undefined || now() - entry.fetchedAt > CACHE_MS) entry = (await load(teamDomain)) ?? entry;
    if (entry !== undefined && !entry.keys.has(kid) && now() - entry.fetchedAt > REFETCH_MS) {
      entry = (await load(teamDomain)) ?? entry;
    }
    return entry?.keys.get(kid) ?? null;
  }

  return {
    async keysReachable(teamDomain) {
      return (await load(teamDomain)) !== null;
    },
    async verify(token, config) {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
      const header = decodeJson(headerPart);
      const payload = decodeJson(payloadPart);
      const signature = decodeBytes(signaturePart);
      if (header === null || payload === null || signature === null) return null;
      if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return null;

      const key = await keyFor(config.teamDomain, header["kid"]);
      if (key === null) return null;
      const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
      if (!(await crypto.subtle.verify(ALGORITHM.name, key, signature, signed))) return null;

      if (payload["iss"] !== `https://${config.teamDomain}`) return null;
      const aud = payload["aud"];
      if (!(Array.isArray(aud) ? aud.includes(config.aud) : aud === config.aud)) return null;
      const seconds = now() / 1000;
      const exp = payload["exp"];
      if (typeof exp !== "number" || exp + LEEWAY_SECONDS < seconds) return null;
      const nbf = payload["nbf"];
      if (nbf !== undefined && (typeof nbf !== "number" || nbf - LEEWAY_SECONDS > seconds)) return null;

      const email = payload["email"];
      return { email: typeof email === "string" ? email : null };
    },
  };
}

async function fetchKeys(fetchFn: typeof fetch, teamDomain: string): Promise<Map<string, CryptoKey> | null> {
  let body: unknown;
  try {
    const res = await fetchFn(certsUrl(teamDomain), { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }
  const jwks = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(jwks)) return null;
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks as (JsonWebKey & { kid?: unknown })[]) {
    if (typeof jwk?.kid !== "string" || jwk.kty !== "RSA") continue;
    try {
      const { kid, ...rest } = jwk;
      keys.set(kid, await crypto.subtle.importKey("jwk", { ...rest, alg: "RS256" }, ALGORITHM, false, ["verify"]));
    } catch {
      // A key this runtime cannot import is not one Access signs with; skip it.
    }
  }
  return keys.size > 0 ? keys : null;
}

function decodeBytes(part: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  try {
    const binary = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = decodeBytes(part);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
export const ACCESS_JWT_COOKIE = "CF_Authorization";

/** The Access JWT a request carries: the header the Access edge adds, else the cookie it sets in the browser. */
export function accessTokenOf(request: Request): string | null {
  const header = request.headers.get(ACCESS_JWT_HEADER);
  if (header) return header;
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === ACCESS_JWT_COOKIE) return value.join("=") || null;
  }
  return null;
}

export type AccessVerdict = { on: false } | { on: true; identity: AccessIdentity | null };

/** Whether Access mode is on and, if so, who the request's Access JWT says the caller is (`null`: nobody). */
export async function accessVerdict(db: D1Database, request: Request, verifier: AccessVerifier): Promise<AccessVerdict> {
  const config = await getAccessConfig(db);
  if (config === null) return { on: false };
  const token = accessTokenOf(request);
  return { on: true, identity: token === null ? null : await verifier.verify(token, config) };
}

/** The verifier the Worker uses; `fetch` is looked up on each call so tests can stand in for the Access edge. */
export const accessVerifier = createAccessVerifier({ fetch: (input, init) => fetch(input, init) });
