// List cursors (ADR 0009, *Listing*): an opaque base64url encoding of `createdAt|slug`, the position of the last
// row of a page in `createdAt desc, slug desc` order.

import { isCustomSlug } from "@furea/shared";
import type { ListPosition } from "../core/db/links.ts";

/** The timestamp form the Worker stores (`Date.toISOString()`). */
const STORED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Never part of a timestamp or a slug. */
const SEPARATOR = "|";

export function encodeCursor({ createdAt, slug }: ListPosition): string {
  return btoa(`${createdAt}${SEPARATOR}${slug}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `null` for anything this function did not produce. */
export function decodeCursor(cursor: string): ListPosition | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let text: string;
  try {
    text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const [createdAt, slug, ...rest] = text.split(SEPARATOR);
  if (createdAt === undefined || slug === undefined || rest.length > 0) return null;
  if (!STORED_TIMESTAMP.test(createdAt) || !isCustomSlug(slug)) return null;
  return { createdAt, slug };
}
