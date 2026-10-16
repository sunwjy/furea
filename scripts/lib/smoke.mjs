// The shared smoke set (docs/testing.md, *Compat* and *Integration*): log in with the operator password, create a
// link through the public API, follow its short URL to the 302, and find it in the link list. It talks HTTP only,
// so it runs the same against a local miniflare instance and a real workers.dev hostname.

/** A destination that is never "the instance itself" and skips destination screening (an IP literal, ADR 0013). */
const DESTINATION = "http://192.0.2.1/furea-smoke";

export class SmokeError extends Error {
  /** @param {string} step @param {string} message */
  constructor(step, message) {
    super(`${step}: ${message}`);
    this.step = step;
  }
}

/** @param {Response} res */
async function describe(res) {
  return `${res.status} ${(await res.text()).slice(0, 300)}`;
}

/**
 * @param {string} baseUrl the instance's origin, e.g. `https://furea.example.workers.dev`
 * @param {{ password: string, slug?: string, fetch?: typeof fetch, log?: (line: string) => void }} options
 * @returns {Promise<{ slug: string, destination: string }>} the link it created
 */
export async function runSmoke(baseUrl, { password, slug = `smoke-${Date.now().toString(36)}`, fetch = globalThis.fetch, log = () => {} }) {
  const origin = new URL(baseUrl).origin;
  const destination = `${DESTINATION}?slug=${slug}`;

  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password }),
  });
  if (login.status !== 204) throw new SmokeError("login", await describe(login));
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new SmokeError("login", "no session cookie in the response");
  log("ok  login");
  // Browser-session writes must carry the instance's own Origin (ADR 0003).
  const session = { cookie, origin };

  const create = await fetch(`${origin}/api/v1/links`, {
    method: "POST",
    headers: { ...session, "content-type": "application/json" },
    body: JSON.stringify({ destination, slug }),
  });
  if (create.status !== 201) throw new SmokeError("create link", await describe(create));
  log(`ok  create link /${slug}`);

  const redirect = await fetch(`${origin}/${slug}`, { redirect: "manual" });
  const location = redirect.headers.get("location");
  if (redirect.status !== 302 || location !== destination) {
    throw new SmokeError("redirect", `expected 302 to ${destination}, got ${redirect.status} to ${location}`);
  }
  await redirect.body?.cancel();
  log("ok  redirect 302");

  const list = await fetch(`${origin}/api/v1/links`, { headers: session });
  if (list.status !== 200) throw new SmokeError("list", await describe(list));
  const { items } = await list.json();
  if (!Array.isArray(items) || !items.some((link) => link.slug === slug)) {
    throw new SmokeError("list", `/${slug} is not in GET /api/v1/links`);
  }
  log("ok  list");

  return { slug, destination };
}
