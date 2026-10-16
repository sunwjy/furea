import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT = fileURLToPath(new URL("./check-expand-only.mjs", import.meta.url));

test("with nothing published it prints `skip: no previous release` and exits 0", async () => {
  // A registry that has never heard of furea: npm itself gets the 404, as it would from npmjs.com before 0.1.0.
  const registry = createServer((_, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = registry.address();
    const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT], {
      env: { ...process.env, npm_config_registry: `http://127.0.0.1:${port}/` },
    });
    assert.match(stdout, /^skip: no previous release$/m);
  } finally {
    registry.close();
  }
});

test("a registry it cannot reach is a failure, not a skip", async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  closed.close();
  const result = await promisify(execFile)(process.execPath, [SCRIPT], {
    env: { ...process.env, npm_config_registry: `http://127.0.0.1:${port}/`, npm_config_fetch_retries: "0" },
  }).then(
    () => ({ code: 0, stdout: "" }),
    (err) => ({ code: err.code, stdout: err.stdout }),
  );
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /skip/);
});
