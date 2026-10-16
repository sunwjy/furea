import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("./integration.mjs", import.meta.url));

for (const missing of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  test(`it refuses to start without ${missing}, before packing or calling anything`, async () => {
    const env = { ...process.env, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };
    delete env[missing];
    const result = await promisify(execFile)(process.execPath, [SCRIPT], { env }).then(
      () => ({ code: 0, stderr: "" }),
      (err) => ({ code: err.code, stderr: err.stderr }),
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`needs ${missing}`));
  });
}
