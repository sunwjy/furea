import { expect, type Page, test } from "@playwright/test";
import { OPERATOR_PASSWORD } from "./instance.ts";

// The admin smoke (docs/testing.md): flows run in order in one browser session; later tickets append flows.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page.close();
});

test("1. log in with the seeded operator password", async () => {
  await page.goto("/admin/campaigns");
  await expect(page).toHaveURL(/\/admin\/login\?redirect=/);

  await page.getByLabel("Password").fill("not the operator password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();

  await page.getByLabel("Password").fill(OPERATOR_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  // Back on the deep link the login started from, inside the authenticated shell.
  await expect(page).toHaveURL(/\/admin\/campaigns$/);
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(["Links", "Campaigns", "Security", "Settings"]);

  // The session survives a reload, and the cookie is the __Host- session cookie.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === "__Host-furea_session")).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });

  await nav.getByRole("link", { name: "Links" }).click();
  await expect(page.getByRole("heading", { name: "Links" })).toBeVisible();
});
