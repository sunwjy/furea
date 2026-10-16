// The update check of ADR 0006: the deployed version (D), this installer (I) and the registry's `latest` (L).
// L is looked up once, by `status` and at the end of `deploy`, without credentials and with a 2-second limit;
// any failure is silent and leaves I as the newest known release. Nothing here ever changes an exit code.

import { RELEASES_URL } from "./links.ts";
import { crossesReleaseLine, isNewer, isSnapshot, isVersion } from "./version.ts";

const NPMJS = "https://registry.npmjs.org";
const TIMEOUT_MS = 2000;
const UPGRADE = "npx furea@latest deploy";

export interface UpdateCheckDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** `--no-update-check`; `FUREA_NO_UPDATE_CHECK=1` is read from `env`. CI is deliberately not detected. */
  skip: boolean;
}

function optedOut(deps: UpdateCheckDeps): boolean {
  const value = deps.env.FUREA_NO_UPDATE_CHECK?.trim().toLowerCase();
  return deps.skip || (value !== undefined && value !== "" && value !== "0" && value !== "false");
}

/** The registry's `latest` dist-tag, or undefined when the lookup is skipped or fails in any way. */
export async function latestRelease(deps: UpdateCheckDeps): Promise<string | undefined> {
  if (optedOut(deps)) return undefined;
  const registry = (deps.env.npm_config_registry || deps.env.NPM_CONFIG_REGISTRY || NPMJS).replace(/\/+$/, "");
  try {
    const response = await deps.fetch(`${registry}/-/package/furea/dist-tags`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const latest = ((await response.json()) as { latest?: unknown }).latest;
    return typeof latest === "string" && isVersion(latest) ? latest : undefined;
  } catch {
    return undefined;
  }
}

/** The one line `status` prints, from the ADR 0006 table. */
export function statusUpdateLine(deployed: string, installer: string, latest: string | undefined): string {
  if (isNewer(deployed, installer)) return `This installer (${installer}) is older than the instance (${deployed}). Use npx furea@latest.`;
  if (isSnapshot(deployed)) return `Snapshot deployed (${deployed}); replace it with a release: ${UPGRADE}`;
  const newest = latest !== undefined && isNewer(latest, installer) ? latest : installer;
  if (!isNewer(newest, deployed)) return "Up to date.";
  if (crossesReleaseLine(deployed, newest)) {
    return `Read the release notes before upgrading ${deployed} → ${newest}: ${RELEASES_URL}. Then run: ${UPGRADE}`;
  }
  return `Update available: ${deployed} → ${newest}. Run: ${UPGRADE}`;
}

/** The hint at the end of `deploy` when a newer release than the one just deployed exists, else undefined. */
export function deployUpdateLine(installer: string, latest: string | undefined): string | undefined {
  if (latest === undefined || !isNewer(latest, installer)) return undefined;
  return `furea ${latest} is out; this installer deployed ${installer} (a cached or pinned version). Run: ${UPGRADE}`;
}
