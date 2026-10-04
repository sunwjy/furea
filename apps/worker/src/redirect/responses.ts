// Fixed responses of the redirect path (ADR 0004, ADR 0008). Each call builds a fresh Response from constants.

const UNKNOWN_SLUG_BODY =
  '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Not found</title></head>\n<body>Not found</body>\n</html>\n';

const ROBOTS_TXT = "User-agent: *\nDisallow: /admin/\nDisallow: /api/\n";

/** One response for unknown, disabled, malformed, multi-segment and reserved paths: no instance detail, never cached. */
export function unknownSlug(): Response {
  return new Response(UNKNOWN_SLUG_BODY, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
  });
}

/** Every redirect is a 302 that no cache may keep, so edits take effect and every click reaches the Worker. */
export function redirectTo(destination: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: destination, "Cache-Control": "no-store" },
  });
}

export function robotsTxt(): Response {
  return new Response(ROBOTS_TXT, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
