// Prepares a fresh local instance for the E2E smoke (docs/testing.md): applies the real migrations to a local D1,
// seeds the operator password hashed with the `shared` function the Worker verifies with, then starts
// `wrangler dev` on the built admin assets and waits until it answers.

import { execFileSync, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { hashPassword } from "@furea/shared";
import { BASE_URL, OPERATOR_PASSWORD, PORT } from "./instance.ts";

const WORKER_DIR = new URL("../../worker/", import.meta.url).pathname;
const WRANGLER = new URL("node_modules/.bin/wrangler", `file://${WORKER_DIR}`).pathname;
const STATE_DIR = new URL("../.wrangler/e2e-state/", import.meta.url).pathname;
const ENV = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };

function wrangler(args: string[]): void {
  execFileSync(WRANGLER, [...args, "--persist-to", STATE_DIR], { cwd: WORKER_DIR, env: ENV, stdio: "inherit" });
}

async function waitForInstance(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE_URL}/robots.txt`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`wrangler dev did not answer on ${BASE_URL} within ${timeoutMs} ms`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await rm(STATE_DIR, { recursive: true, force: true });
  wrangler(["d1", "migrations", "apply", "DB", "--local"]);
  const hash = await hashPassword(OPERATOR_PASSWORD);
  wrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--command",
    `INSERT INTO settings (key, value) VALUES ('operator_password_hash', '${hash}')`,
  ]);

  const dev = spawn(
    WRANGLER,
    ["dev", "--port", String(PORT), "--persist-to", STATE_DIR, "--show-interactive-dev-session=false"],
    { cwd: WORKER_DIR, env: ENV, stdio: ["ignore", "inherit", "inherit"] },
  );
  const exited = new Promise<never>((_, reject) =>
    dev.once("exit", (code) => reject(new Error(`wrangler dev exited early with code ${code}`))),
  );
  await Promise.race([waitForInstance(60_000), exited]);
  exited.catch(() => {});

  return async () => {
    dev.kill();
  };
}
