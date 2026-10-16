// The refusal of a flagged destination (ADR 0013): names the host and offers the session-only override, which
// resends the same request with `"screening": "skip"`.

import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ScreeningRefusal({
  host,
  action,
  pending,
  onOverride,
}: {
  host: string;
  /** "Create anyway" or "Save anyway". */
  action: string;
  pending: boolean;
  onOverride: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p className="flex gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>
          <strong className="break-all">{host}</strong> is flagged as malware or phishing by 1.1.1.1 for Families, so
          it was not saved. Check the address; if you are sure it is safe, you can save it anyway.
        </span>
      </p>
      <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={onOverride}>
        {action}
      </Button>
    </div>
  );
}
