// Test-only, never imported by the Worker: a stand-in Cloudflare Access team with a real RSA signing key, the certs
// document Access publishes at https://<team>/cdn-cgi/access/certs, and JWTs signed the way Access signs them (RS256,
// `kid` in the header).

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

export interface TestTeam {
  teamDomain: string;
  aud: string;
  kid: string;
  /** The body of `GET https://<teamDomain>/cdn-cgi/access/certs`. */
  certs: { keys: JsonWebKey[] };
  /** A JWT for this team; `claims` override the defaults (valid for an hour from `now`). */
  sign(claims?: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function createTestTeam(teamDomain: string, kid = "test-key-1"): Promise<TestTeam> {
  const pair = (await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const aud = `aud-${teamDomain.split(".")[0]}-${"0".repeat(48)}`;
  return {
    teamDomain,
    aud,
    kid,
    certs: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey] },
    async sign(claims = {}, header = {}) {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        aud: [aud],
        email: "operator@example.com",
        exp: now + 3600,
        iat: now,
        nbf: now,
        iss: `https://${teamDomain}`,
        type: "app",
        sub: "00000000-0000-0000-0000-000000000001",
        ...claims,
      };
      const input = `${b64url({ alg: "RS256", kid, typ: "JWT", ...header })}.${b64url(payload)}`;
      const signature = await crypto.subtle.sign(ALGORITHM.name, pair.privateKey, new TextEncoder().encode(input));
      return `${input}.${bytesToB64url(new Uint8Array(signature))}`;
    },
  };
}

/** A `fetch` that answers each team's certs URL from `teams` and fails every other request. */
export function certsFetch(...teams: TestTeam[]): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const team = teams.find((t) => url === `https://${t.teamDomain}/cdn-cgi/access/certs`);
    if (team === undefined) return new Response("not found", { status: 404 });
    return Response.json(team.certs);
  };
}

const b64url = (value: unknown) => bytesToB64url(new TextEncoder().encode(JSON.stringify(value)));

function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
