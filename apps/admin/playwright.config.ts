import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./e2e/instance.ts";

// The E2E smoke (docs/testing.md): one serial spec, chromium only, against `wrangler dev` on the built admin.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? [["github"], ["list"]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
