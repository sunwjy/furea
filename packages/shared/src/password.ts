// Operator-password hashing (ADR 0003), shared by the Worker (login), the CLI (installer, reset-password) and
// the E2E seed, so every writer and the one reader agree on the format by construction.
//
// Stored format, PHC-style: `$pbkdf2-sha256$i=<iterations>$<salt>$<digest>`, salt and digest in standard
// base64 without padding. The golden vector in password.test.ts pins it across releases.

const TAG = "pbkdf2-sha256";
/** Workers' Web Crypto refuses PBKDF2 above 100,000 iterations, so this is the most the login can afford. */
export const PASSWORD_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DIGEST_BYTES = 32;

export interface HashOptions {
  /** Fixed salt for golden vectors; a fresh random one otherwise. */
  salt?: Uint8Array;
  iterations?: number;
}

export async function hashPassword(password: string, options: HashOptions = {}): Promise<string> {
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iterations = options.iterations ?? PASSWORD_ITERATIONS;
  const digest = await derive(password, salt, iterations);
  return `$${TAG}$i=${iterations}$${toBase64(salt)}$${toBase64(digest)}`;
}

/** Constant-time over the digest. A stored value that does not parse never verifies. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (parsed === null) return false;
  const digest = await derive(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(digest, parsed.digest);
}

/** Compares two byte strings in time that depends only on their lengths. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    key,
    DIGEST_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function parse(stored: string): { iterations: number; salt: Uint8Array; digest: Uint8Array } | null {
  const match = /^\$pbkdf2-sha256\$i=([1-9][0-9]{0,8})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  if (match === null) return null;
  const salt = fromBase64(match[2] as string);
  const digest = fromBase64(match[3] as string);
  const iterations = Number(match[1]);
  // Above the Workers cap the login could only throw, so such a value is as unusable as a malformed one.
  if (iterations > PASSWORD_ITERATIONS || salt === null || digest === null || digest.length !== DIGEST_BYTES) return null;
  return { iterations, salt, digest };
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
