// Small Web Crypto helpers shared by the auth code: session ids and API keys.

import { randomAlphabetString } from "@furea/shared";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `bytes` random bytes as base64url without padding. */
export function randomToken(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const API_KEY_PREFIX = "furea_";
/** 45 symbols of the 56-symbol alphabet carry at least the 256 bits of 32 random bytes (ADR 0003). */
const API_KEY_SECRET_LENGTH = 45;
const API_KEY_ID_LENGTH = 12;
const API_KEY_RECOGNITION_LENGTH = 8;

/** A new API key: its id, the key shown once, and the 8 characters after `furea_` kept for lists. */
export function generateApiKey(): { id: string; key: string; prefix: string } {
  const secret = randomAlphabetString(API_KEY_SECRET_LENGTH);
  return {
    id: randomAlphabetString(API_KEY_ID_LENGTH),
    key: `${API_KEY_PREFIX}${secret}`,
    prefix: secret.slice(0, API_KEY_RECOGNITION_LENGTH),
  };
}
