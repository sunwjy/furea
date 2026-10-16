// Destination screening on the API's writes (ADR 0013): every write that sets a destination runs it after
// validation and before D1; a flagged host refuses the write unless a session sends `"screening": "skip"`.

import { log } from "../core/log.ts";
import { screenDestinations, type ScreenedDestination } from "../core/screening.ts";
import type { Caller } from "./context.ts";
import { apiError } from "./errors.ts";

/** What the write is left to log once it knows its slug (`_` for the root destination). */
export type ScreeningOutcome = "passed" | "overridden" | "unavailable";

/**
 * Screens the destinations a write sets; an empty list (a patch that leaves them alone) looks nothing up. Answers the
 * refusal to send instead of writing (`403` for an override from an API key, `422 destination_flagged`), or the outcome
 * to hand to {@link logScreening} after the write.
 */
export async function screen(
  caller: Caller | null,
  destinations: readonly ScreenedDestination[],
  override: "skip" | undefined,
): Promise<Response | ScreeningOutcome> {
  if (override !== undefined && caller?.kind !== "session") {
    return apiError(403, "forbidden", "Session required to override screening.");
  }
  if (destinations.length === 0) return "passed";
  if (override === "skip") return "overridden";

  const { flagged, unavailable } = await screenDestinations(destinations, { fetch: globalThis.fetch });
  if (flagged.length > 0) {
    return apiError(422, "destination_flagged", "The destination is flagged as malware or phishing.", {
      details: flagged.map(({ field, host }) => ({
        field,
        host,
        code: "destination_flagged",
        message: `${host} is flagged as malware or phishing by 1.1.1.1 for Families.`,
      })),
    });
  }
  return unavailable ? "unavailable" : "passed";
}

/** `subject` is the slug written (`_` for the root destination), or the campaign created. */
export function logScreening(outcome: ScreeningOutcome, subject: string | { campaign: string }): void {
  const fields = typeof subject === "string" ? { slug: subject } : subject;
  if (outcome === "overridden") log({ event: "screening_overridden", ...fields });
  else if (outcome === "unavailable") log({ event: "screening_unavailable", ...fields });
}
