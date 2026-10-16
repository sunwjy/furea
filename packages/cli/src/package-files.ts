// Files the published package carries (ADR 0007), located relative to this module, never the working
// directory. The same lookup works from `src/` in tests and from the bundled `dist/cli/index.js`.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The directory of the `furea` package that contains this module. */
export function packageRoot(from: string | URL = import.meta.url): URL {
  let dir = new URL("./", from);
  for (;;) {
    const manifest = new URL("package.json", dir);
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (name === "furea") return dir;
    }
    const parent = new URL("../", dir);
    if (parent.href === dir.href) throw new Error(`No furea package.json above ${fileURLToPath(from)}`);
    dir = parent;
  }
}

export function packageVersion(): string {
  const { version } = JSON.parse(readFileSync(new URL("package.json", packageRoot()), "utf8")) as { version: string };
  return version;
}

export interface PackageFiles {
  workerScript: URL;
  workerManifest: URL;
  assetsRoot: URL;
  migrations: URL;
}

/** What `deploy` installs: this package's own version and files, so CLI and Worker never diverge (ADR 0007). */
export interface Installer {
  version: string;
  files: PackageFiles;
}

export function ownInstaller(): Installer {
  return { version: packageVersion(), files: packageFiles() };
}

/** Paths inside the package: the Worker bundle and manifest, the assets root and the migrations directory. */
export function packageFiles(root: URL = packageRoot()): PackageFiles {
  return {
    workerScript: new URL("dist/worker/index.js", root),
    workerManifest: new URL("dist/worker/manifest.json", root),
    assetsRoot: new URL("dist/assets/", root),
    migrations: new URL("migrations/", root),
  };
}
