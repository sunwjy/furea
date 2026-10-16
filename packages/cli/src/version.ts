// Version order for the deploy gate (ADR 0006): plain semver for releases, and every snapshot
// (`0.0.0-<sha>-<timestamp>`, ADR 0010) older than every release.

interface Parsed {
  core: [number, number, number];
  /** Snapshot build time (the last pre-release segment), or undefined for a release. */
  snapshot: string | undefined;
}

function parse(version: string): Parsed {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`"${version}" is not a furea version.`);
  const pre = match[4];
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    snapshot: pre === undefined ? undefined : (pre.split("-").at(-1) ?? pre),
  };
}

/** Whether `a` is strictly newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  if (x.snapshot === undefined && y.snapshot !== undefined) return true;
  if (x.snapshot !== undefined && y.snapshot === undefined) return false;
  if (x.snapshot !== undefined && y.snapshot !== undefined) {
    // Snapshot timestamps are fixed-width, so they order as strings.
    return x.snapshot.localeCompare(y.snapshot) > 0;
  }
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]!;
  }
  return false;
}
