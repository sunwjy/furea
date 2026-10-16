// Destination screening against 1.1.1.1 for Families over DNS-over-HTTPS (ADR 0013). Domain-level only: one `A`
// lookup per distinct host; a host is flagged when the answer carries EDE(16) (Censored) or a `0.0.0.0` record.
// IP literals, NXDOMAIN and empty answers pass. A failed lookup (including an RCODE other than NOERROR or
// NXDOMAIN, such as SERVFAIL or REFUSED) never flags: the caller fails open.

export const DOH_ENDPOINT = "https://security.cloudflare-dns.com/dns-query";
export const SCREENING_TIMEOUT_MS = 1500;

export interface ScreenedDestination {
  /** The request field the destination came from, echoed in `details`. */
  field: string;
  /** An absolute http(s) URL that already passed validation. */
  url: string;
}

export interface FlaggedDestination {
  field: string;
  host: string;
}

export interface ScreeningResult {
  flagged: FlaggedDestination[];
  /** At least one lookup failed (timeout, network error, non-2xx, malformed answer). */
  unavailable: boolean;
}

export interface ScreeningOptions {
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

const NOERROR = 0;
const NXDOMAIN = 3;

type Verdict = "flagged" | "clean" | "unavailable";

interface DohAnswer {
  /** The DNS RCODE: 0 NOERROR, 3 NXDOMAIN; anything else (SERVFAIL, REFUSED, …) is a failed lookup. */
  Status?: number;
  Answer?: { type?: number; data?: string }[];
  Comment?: string[] | string;
}

/** `Example.com.` and `example.com` are one host; `URL` already lower-cases it. */
const hostOf = (url: string) => new URL(url).hostname.replace(/\.$/, "");

const isIpLiteral = (host: string) => host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

export async function screenDestinations(
  destinations: readonly ScreenedDestination[],
  options: ScreeningOptions,
): Promise<ScreeningResult> {
  const withHost = destinations.map((d) => ({ field: d.field, host: hostOf(d.url) }));
  const hosts = [...new Set(withHost.map((d) => d.host))].filter((host) => !isIpLiteral(host));
  const verdicts = new Map(
    await Promise.all(hosts.map(async (host) => [host, await lookup(host, options)] as const)),
  );
  return {
    flagged: withHost.filter((d) => verdicts.get(d.host) === "flagged"),
    unavailable: [...verdicts.values()].includes("unavailable"),
  };
}

async function lookup(host: string, { fetch, timeoutMs = SCREENING_TIMEOUT_MS }: ScreeningOptions): Promise<Verdict> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=A`;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return "unavailable";
    const body = (await res.json()) as DohAnswer;
    const comments = Array.isArray(body.Comment) ? body.Comment : body.Comment ? [body.Comment] : [];
    if (comments.some((c) => /\bEDE\(16\)/.test(c))) return "flagged";
    if (body.Status !== NOERROR && body.Status !== NXDOMAIN) return "unavailable";
    if ((body.Answer ?? []).some((a) => a.type === 1 && a.data === "0.0.0.0")) return "flagged";
    return "clean";
  } catch {
    return "unavailable";
  }
}
