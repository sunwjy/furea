// The admin SPA as Workers Static Assets (ADR 0006 step 5): a manifest of wrangler-compatible hashes, an
// upload session, bucketed uploads, and a completion token for the script upload. A session whose upload
// token has expired is reopened; Cloudflare then asks only for the files it still lacks.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CloudflareApiError, type CloudflareClient } from "./cloudflare/client.ts";
import { CliError } from "./io.ts";

/** wrangler's scheme: blake3 of the base64 contents followed by the extension, first 32 hex characters. */
export function assetHash(path: string, contents: Uint8Array): string {
  const input = Buffer.from(contents).toString("base64") + extname(path).slice(1);
  return bytesToHex(blake3(new TextEncoder().encode(input))).slice(0, 32);
}

// Metafiles wrangler keeps out of the upload; `_headers` and `_redirects` travel in the assets config instead.
const META_FILES = new Set([".assetsignore", "_headers", "_redirects"]);

// The served types of what the admin build emits; anything else is uploaded without one, as wrangler does
// for types it does not know.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export function contentType(path: string): string | undefined {
  const type = CONTENT_TYPES[extname(path).toLowerCase()];
  return type?.startsWith("text/") ? `${type}; charset=utf-8` : type;
}

export interface AssetFile {
  /** Absolute path on disk. */
  file: string;
  hash: string;
  size: number;
}

export interface AssetSet {
  /** Served path (`/admin/index.html`) to file. */
  files: Map<string, AssetFile>;
  /** The assets config the script upload carries. */
  config: Record<string, string>;
}

export function readAssets(root: URL): AssetSet {
  const dir = fileURLToPath(root);
  const files = new Map<string, AssetFile>();
  const config: Record<string, string> = {};
  for (const relative of (readdirSync(dir, { recursive: true }) as string[]).sort()) {
    const file = join(dir, relative);
    if (!statSync(file).isFile()) continue;
    if (META_FILES.has(relative)) {
      if (relative !== ".assetsignore") config[relative] = readFileSync(file, "utf8");
      continue;
    }
    const contents = readFileSync(file);
    files.set(`/${relative.split(sep).join("/")}`, { file, hash: assetHash(relative, contents), size: contents.length });
  }
  return { files, config };
}

export interface AssetSync {
  /** The completion token for `metadata.assets.jwt`. */
  jwt: string;
  uploaded: number;
  reopened: number;
}

const MAX_REOPENS = 3;

export async function syncAssets(client: CloudflareClient, accountId: string, script: string, assets: AssetSet): Promise<AssetSync> {
  const manifest = Object.fromEntries([...assets.files].map(([path, { hash, size }]) => [path, { hash, size }]));
  const byHash = new Map([...assets.files.values()].map((asset) => [asset.hash, asset]));
  const uploaded = new Set<string>();
  for (let reopened = 0; ; reopened++) {
    const session = await client.createAssetUploadSession(accountId, script, manifest);
    if (session.buckets.length === 0) return { jwt: session.jwt, uploaded: uploaded.size, reopened };
    let completion: string | undefined;
    try {
      for (const bucket of session.buckets) {
        const form = new FormData();
        for (const hash of bucket) {
          const asset = byHash.get(hash);
          if (!asset) throw new CliError(`Cloudflare asked for an asset furea does not have (${hash}).`);
          const type = contentType(asset.file) ?? "application/null";
          form.append(hash, new File([readFileSync(asset.file).toString("base64")], hash, { type }), hash);
        }
        const result = await client.uploadAssets(accountId, session.jwt, form);
        bucket.forEach((hash) => uploaded.add(hash));
        completion = result?.jwt || completion;
      }
    } catch (error) {
      // The upload token lives one hour; a `401` means the session is gone, not the deploy token.
      if (error instanceof CloudflareApiError && error.status === 401 && reopened < MAX_REOPENS) continue;
      throw error;
    }
    if (!completion) throw new CliError("Cloudflare finished the asset upload without a completion token; run deploy again.");
    return { jwt: completion, uploaded: uploaded.size, reopened };
  }
}
