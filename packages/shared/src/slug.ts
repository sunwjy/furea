// Slug rules and reserved paths (ADR 0002).

/** Base62 minus the look-alike characters `0 O o 1 I l`: 56 symbols. */
export const GENERATED_SLUG_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
export const GENERATED_SLUG_LENGTH = 6;
export const CUSTOM_SLUG_MAX_LENGTH = 64;

const CUSTOM_SLUG = new RegExp(`^[A-Za-z0-9_-]{1,${CUSTOM_SLUG_MAX_LENGTH}}$`);

/** A fresh six-character slug drawn uniformly from the generated alphabet. */
export function generateSlug(): string {
  const n = GENERATED_SLUG_ALPHABET.length;
  // Largest multiple of n below 256; bytes at or above it are rejected so every symbol is equally likely.
  const limit = 256 - (256 % n);
  let slug = "";
  while (slug.length < GENERATED_SLUG_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(GENERATED_SLUG_LENGTH * 2));
    for (const b of bytes) {
      if (b >= limit) continue;
      slug += GENERATED_SLUG_ALPHABET[b % n];
      if (slug.length === GENERATED_SLUG_LENGTH) break;
    }
  }
  return slug;
}

/** Custom slug syntax: `[A-Za-z0-9_-]{1,64}`, one path segment, never normalised. */
export function isCustomSlug(value: string): boolean {
  return CUSTOM_SLUG.test(value);
}

const RESERVED_NAMES = new Set(["admin", "api", "favicon.ico", "robots.txt"]);

/**
 * Whether a single path segment is reserved for the instance itself.
 * Matched case-insensitively even though slugs are case-sensitive, so `Admin` can never be a link.
 */
export function isReservedPath(segment: string): boolean {
  if (segment.startsWith("_") || segment.startsWith(".")) return true;
  return RESERVED_NAMES.has(segment.toLowerCase());
}
