// UTM parse and compose (ADR 0014). The destination string is never rebuilt with `URL` / `URLSearchParams`: compose
// keeps every byte outside the six recognised pairs and re-appends those pairs in one fixed order and encoding.

/** The six recognised keys, lowercase only, in the order compose writes them (Google's Campaign URL Builder). */
export const UTM_KEYS = ["utm_id", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type UtmValues = Partial<Record<UtmKey, string>>;

function isUtmKey(key: string): key is UtmKey {
  return (UTM_KEYS as readonly string[]).includes(key);
}

interface SplitUrl {
  /** Everything before the `?` (or the whole string up to the fragment when there is no query). */
  head: string;
  /** The `&`-separated pairs between `?` and `#`, as entered; `null` when there is no `?`. */
  pairs: string[] | null;
  /** The `#fragment` including its `#`, or `""`. */
  fragment: string;
}

/** Splits on the first `#`, then on the first `?` before it. A `?` inside the fragment is not a query. */
function split(destination: string): SplitUrl {
  const hash = destination.indexOf("#");
  const beforeFragment = hash === -1 ? destination : destination.slice(0, hash);
  const fragment = hash === -1 ? "" : destination.slice(hash);
  const question = beforeFragment.indexOf("?");
  if (question === -1) return { head: beforeFragment, pairs: null, fragment };
  return { head: beforeFragment.slice(0, question), pairs: beforeFragment.slice(question + 1).split("&"), fragment };
}

/** The key of a pair is everything before its first `=` (the whole pair when it has none). */
function keyOf(pair: string): string {
  const eq = pair.indexOf("=");
  return eq === -1 ? pair : pair.slice(0, eq);
}

/**
 * Writes `values` into `destination`: removes every recognised UTM pair, keeps all other bytes and their order, and
 * appends the trimmed non-empty values after the query and before the fragment, in `UTM_KEYS` order, each encoded
 * with `encodeURIComponent`. No separator is doubled, and no `?` is left when no pairs remain.
 */
export function composeUtm(destination: string, values: UtmValues): string {
  const { head, pairs, fragment } = split(destination);
  const kept = (pairs ?? []).filter((pair) => !isUtmKey(keyOf(pair))).join("&");
  const added = UTM_KEYS.flatMap((key) => {
    const value = values[key]?.trim() ?? "";
    return value === "" ? [] : [`${key}=${encodeURIComponent(value)}`];
  }).join("&");
  if (kept === "" && added === "") return head + fragment;
  if (added === "") return `${head}?${kept}${fragment}`;
  const separator = kept === "" || kept.endsWith("&") ? "" : "&";
  return `${head}?${kept}${separator}${added}${fragment}`;
}

/** What every member of a campaign shares (ADR 0012): the base URL, the UTM campaign and the optional `utm_id`. */
export interface CampaignUtmParts {
  baseUrl: string;
  utmCampaign: string;
  utmId: string | null;
}

/** A campaign link's own values (ADR 0012): source and medium, and optional content and term. */
export interface OwnUtmValues {
  source: string;
  medium: string;
  content?: string | null | undefined;
  term?: string | null | undefined;
}

/** A campaign link's destination: the campaign's shared part and the link's own values (ADR 0012, ADR 0014). */
export function composeCampaignLink(campaign: CampaignUtmParts, own: OwnUtmValues): string {
  return composeUtm(campaign.baseUrl, {
    utm_id: campaign.utmId ?? "",
    utm_source: own.source,
    utm_medium: own.medium,
    utm_campaign: campaign.utmCampaign,
    utm_term: own.term ?? "",
    utm_content: own.content ?? "",
  });
}

export type UtmWarning =
  /** `UTM_Source` and the like: ordinary query to furea, and most likely ignored by the destination's analytics. */
  | { code: "case_variant_key"; key: string }
  /** The key appears more than once; the first value is shown, and compose collapses it to one. */
  | { code: "duplicate_key"; key: UtmKey }
  /** The value has a malformed percent sequence (`%zz`) and is shown raw. */
  | { code: "malformed_percent"; key: UtmKey };

export interface ParsedUtm {
  /** Every recognised key, `""` when absent or empty. */
  values: Record<UtmKey, string>;
  warnings: UtmWarning[];
}

/** Form-style decoding: `+` and `%20` both read as a space. `null` for a malformed percent sequence. */
function decodeValue(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return null;
  }
}

/**
 * Reads the six recognised UTM parameters out of a destination that already passed `Destination`. A key present
 * more than once shows its first value; warnings name case-variant keys, duplicates and malformed percent sequences.
 */
export function parseUtm(destination: string): ParsedUtm {
  const values: Record<UtmKey, string> = {
    utm_id: "",
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    utm_term: "",
    utm_content: "",
  };
  const warnings: UtmWarning[] = [];
  const seen = new Set<string>();
  for (const pair of split(destination).pairs ?? []) {
    const key = keyOf(pair);
    if (!isUtmKey(key)) {
      if (isUtmKey(key.toLowerCase()) && !seen.has(key)) warnings.push({ code: "case_variant_key", key });
      seen.add(key);
      continue;
    }
    if (seen.has(key)) {
      if (!warnings.some((w) => w.code === "duplicate_key" && w.key === key)) warnings.push({ code: "duplicate_key", key });
      continue;
    }
    seen.add(key);
    const raw = pair.slice(key.length + 1);
    const decoded = decodeValue(raw);
    if (decoded === null) warnings.push({ code: "malformed_percent", key });
    values[key] = decoded ?? raw;
  }
  return { values, warnings };
}

/** Whether the destination's query has one of the six recognised (lowercase) keys, with or without a value. */
export function hasUtmKey(destination: string): boolean {
  return (split(destination).pairs ?? []).some((pair) => isUtmKey(keyOf(pair)));
}

const UTM_CORE = ["utm_source", "utm_medium", "utm_campaign"] as const;

/**
 * Source, medium and campaign left empty while some field is filled: most analytics tools need all three. Empty when
 * no field is filled at all.
 */
export function missingUtmCore(values: UtmValues): UtmKey[] {
  const filled = (key: UtmKey) => (values[key]?.trim() ?? "") !== "";
  if (!UTM_KEYS.some(filled)) return [];
  return UTM_CORE.filter((key) => !filled(key));
}
