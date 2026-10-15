import { expect, type Page, test } from "@playwright/test";
import { OPERATOR_PASSWORD, PORT } from "./instance.ts";

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

const SLUG = "e2e-launch";
// Another hostname for the same local instance: not "the instance itself" to the API, and reachable offline.
const DESTINATION = `http://127.0.0.1:${PORT}/robots.txt?from=e2e`;

test("2. create a link with a custom slug and see it in the feed", async () => {
  await page.getByRole("link", { name: "New link" }).click();
  await expect(page.getByRole("heading", { name: "New link" })).toBeVisible();

  // A field error from the form's schema, before anything is sent.
  await page.getByLabel("Destination").fill("example.com");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByText(/absolute http or https URL/)).toBeVisible();

  await page.getByLabel("Destination").fill(DESTINATION);
  await page.getByLabel("Custom slug (optional)").fill(SLUG);
  await page.getByLabel("Title (optional)").fill("  E2E launch  ");
  await page.getByRole("button", { name: "Create link" }).click();

  await expect(page).toHaveURL(/\/admin\/$/);
  const card = page.getByRole("list", { name: "Links" }).getByRole("listitem").first();
  await expect(card.getByRole("link", { name: `localhost:${PORT}/${SLUG}` })).toBeVisible();
  await expect(card).toContainText(`E2E launch · ${DESTINATION}`);

  // The same slug again is refused on the slug field.
  await page.getByRole("link", { name: "New link" }).click();
  await page.getByLabel("Destination").fill("https://example.com/other");
  await page.getByLabel("Custom slug (optional)").fill(SLUG);
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByText("This slug is taken. Choose another one.")).toBeVisible();

  await page.getByRole("link", { name: "Links" }).first().click();
  await page.getByRole("searchbox", { name: "Search links" }).fill("e2e-laun");
  await expect(page).toHaveURL(/\?q=e2e-laun$/);
  await expect(page.getByRole("list", { name: "Links" }).getByRole("listitem")).toHaveCount(1);
});

test("3. open the short URL and land on the destination with a 302", async () => {
  const res = await page.request.get(`/${SLUG}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toBe(DESTINATION);
  expect(res.headers()["cache-control"]).toBe("no-store");

  await page.goto(`/${SLUG}`);
  await expect(page).toHaveURL(DESTINATION);
  await expect(page.getByText("Disallow: /admin/")).toBeVisible();
});

test("4. edit the link, disable it and get the 404", async () => {
  await page.goto("/admin/");
  const card = page.getByRole("list", { name: "Links" }).getByRole("listitem").first();

  // Edit → Save on the link's own page; the slug is not among the fields.
  await card.getByRole("link", { name: `E2E launch · ${DESTINATION}` }).click();
  await expect(page.getByRole("heading", { name: `/${SLUG}` })).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("Slug")).toHaveCount(0);
  await page.getByLabel("Title (optional)").fill("E2E edited");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Saved /${SLUG}.`)).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "E2E edited" })).toBeVisible();

  await page.getByRole("link", { name: "Links" }).first().click();
  await expect(card).toContainText(`E2E edited · ${DESTINATION}`);
  await card.getByRole("button", { name: "Disable" }).click();
  await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Enable" })).toBeVisible();

  const res = await page.request.get(`/${SLUG}`, { maxRedirects: 0 });
  expect(res.status()).toBe(404);
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(await res.text()).toBe(await (await page.request.get("/no-such-link")).text());
});
