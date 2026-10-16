// Fold keys (ADR 0016): what "compared case-insensitively" means for campaign names and a campaign link's UTM
// combination (ADR 0012). The Worker stores them in `UNIQUE` key columns; the admin surface uses them for early
// warnings. Stored values keep the case and form the operator entered; only the keys are folded.

/** Trim, Unicode NFC, then `toLowerCase()` (no locale). */
export function foldKey(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

/** A campaign link's own UTM values; a missing, `null` or empty content or term are the same. */
export interface UtmCombination {
  source: string;
  medium: string;
  content?: string | null | undefined;
  term?: string | null | undefined;
}

/**
 * `links.campaign_utm_key`: the fold keys of source, medium, content and term. They are joined as a JSON array, whose
 * quoting is the separator that cannot occur inside a fold key, so no two combinations share a key. A comparison key
 * only, never read back as data: the destination is the only stored form of the UTM values.
 */
export function campaignUtmKey({ source, medium, content, term }: UtmCombination): string {
  return JSON.stringify([source, medium, content ?? "", term ?? ""].map(foldKey));
}
