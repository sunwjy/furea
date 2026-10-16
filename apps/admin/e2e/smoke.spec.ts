import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import { BASE_URL, OPERATOR_PASSWORD, PORT } from "./instance.ts";

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
  await expect(page).toHaveURL(/\/admin\/new$/);
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
  await expect(page).toHaveURL(new RegExp(`/admin/links/${SLUG}$`));
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

test("5. create an API key, call the API with it, and revoke it", async () => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Security" }).click();
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();

  await page.getByLabel("Name").fill("e2e script");
  await page.getByLabel(/^Write/).check();
  await page.getByRole("button", { name: "Create key" }).click();

  // Shown once, in a modal.
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("heading", { name: "Copy the key for e2e script" })).toBeVisible();
  const key = await dialog.getByLabel("API key").inputValue();
  expect(key).toMatch(/^furea_[A-Za-z0-9]{45}$/);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  const card = page.getByRole("list", { name: "API keys" }).getByRole("listitem").filter({ hasText: "e2e script" });
  await expect(card).toContainText(`furea_${key.slice(6, 14)}…`);
  await expect(card).toContainText("Never used");

  // A fresh request context: the key alone, no session cookie.
  const script = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const session = await script.get("/api/v1/auth/session", { headers: { authorization: `Bearer ${key}` } });
  expect(await session.json()).toMatchObject({ kind: "apiKey", scope: "write", apiKey: { name: "e2e script" } });
  const minted = await script.post("/api/v1/api-keys", {
    headers: { authorization: `Bearer ${key}` },
    data: { name: "successor", scope: "write" },
  });
  expect(minted.status()).toBe(403);

  await card.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Revoked e2e script.")).toBeVisible();
  await expect(card).toHaveCount(0);

  const revoked = await script.get("/api/v1/auth/session", { headers: { authorization: `Bearer ${key}` } });
  expect(revoked.status()).toBe(401);
  await script.dispose();
});

test("6. see each link's lifetime total on its feed card", async () => {
  // Flow 3 opened the short URL twice (once without following, once in the browser); the link has been disabled
  // since flow 4 and keeps its total.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Links" }).click();
  const card = page.getByRole("list", { name: "Links" }).getByRole("listitem").filter({ hasText: `/${SLUG}` });
  await expect(card.getByText("2 clicks", { exact: true })).toBeVisible();
});

test("7. set a root destination on the Settings page, land on it from /, and unset it", async () => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("npx furea@latest deploy")).toBeVisible();
  await expect(page.getByText("Not configured")).toBeVisible();

  const rootDestination = `http://127.0.0.1:${PORT}/robots.txt?from=root`;
  const field = page.getByLabel("Where the bare hostname redirects");
  await field.fill(rootDestination);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Root destination saved.")).toBeVisible();

  const res = await page.request.get("/", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toBe(rootDestination);
  expect(res.headers()["cache-control"]).toBe("no-store");

  // Empty unsets it: / is the unknown-slug response again.
  await field.fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Root destination removed.")).toBeVisible();
  const unset = await page.request.get("/", { maxRedirects: 0 });
  expect(unset.status()).toBe(404);
  expect(await unset.text()).toBe(await (await page.request.get("/no-such-link")).text());
});

test("8. open the stats page and see the estimates unavailable state, with no analytics token", async () => {
  // The local instance has the CLICKS binding but no ANALYTICS_TOKEN secret.
  const res = await page.request.get("/api/v1/stats?range=7d&tz=Asia/Seoul");
  expect(res.status()).toBe(503);
  expect(await res.json()).toMatchObject({
    error: { code: "analytics_unavailable", details: [{ field: "ANALYTICS_TOKEN", code: "token_missing" }] },
  });

  await page.goto("/admin/");
  const hint = page.getByRole("note", { name: "Estimates unavailable" });
  await expect(hint).toContainText("Estimates unavailable: no analytics token.");
  await expect(page.getByLabel("Overview")).toHaveCount(0);
  const card = page.getByRole("list", { name: "Links" }).getByRole("listitem").filter({ hasText: `/${SLUG}` });
  await expect(card.getByText("2 clicks", { exact: true })).toBeVisible();
  await expect(card.getByRole("img")).toHaveCount(0);

  // The link's own page: the lifetime total stays, the breakdowns give way to the hint.
  await card.getByRole("link", { name: `E2E edited · ${DESTINATION}` }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/links/${SLUG}$`));
  await expect(page.getByRole("note", { name: "Estimates unavailable" })).toContainText("no analytics token");
  await expect(page.getByRole("definition").filter({ hasText: /^2$/ })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Range" })).toHaveCount(0);

  // Dismissed on the feed, it stays dismissed in this browser.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Links" }).click();
  await hint.getByRole("button", { name: "Dismiss" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("list", { name: "Links" })).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test("9. see the Cloudflare Access form on the Security page and have a non-team domain refused", async () => {
  // Turning Access mode on needs a real Access team's public keys, which E2E never fetches; the Worker side of
  // Access mode is covered in the Workers pool with a stand-in team.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Security" }).click();
  await expect(page.getByRole("heading", { name: "Cloudflare Access" })).toBeVisible();
  await page.getByLabel("Team domain").fill("example.com");
  await page.getByLabel("Application Audience (AUD) tag").fill("some-aud");
  await page.getByRole("button", { name: "Turn on Access mode" }).click();
  await expect(page.getByText("Use the team domain, like myteam.cloudflareaccess.com.")).toBeVisible();
  expect(await (await page.request.get("/api/v1/auth/login")).json()).toEqual({ method: "password" });
});

test("10. create a campaign, add two links in the row editor, and land on a composed destination", async () => {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Campaigns" }).click();
  await expect(page.getByText("No campaigns yet.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "New campaign" }).click();
  await expect(page.getByRole("heading", { name: "New campaign" })).toBeVisible();

  const baseUrl = `http://127.0.0.1:${PORT}/robots.txt?from=campaign#top`;
  await page.getByLabel("Name").fill("E2E Spring");
  await page.getByLabel("Base URL").fill(baseUrl);
  // The UTM campaign follows the name until edited.
  await expect(page.getByLabel("UTM campaign")).toHaveValue("E2E Spring");
  await page.getByRole("button", { name: "Create and add links" }).click();

  // Straight on to the row editor; one row typed, one pasted from a spreadsheet.
  await expect(page.getByRole("heading", { name: "Add links to E2E Spring" })).toBeVisible();
  await page.getByLabel("Row 1 Source").fill("Newsletter");
  await page.getByLabel("Row 1 Medium").fill("email");
  await page.getByLabel("Row 1 Custom slug").fill("e2e-spring-news");
  await page.getByRole("button", { name: "Paste from spreadsheet…" }).click();
  await page.getByLabel(/^Paste rows/).fill("source\tmedium\tcontent\ninstagram\tsocial\tstory a\n");
  await page.getByRole("button", { name: "Add rows" }).click();
  await expect(page.getByLabel("Row 2 Content")).toHaveValue("story a");
  await page.getByRole("button", { name: "Create 2 links" }).click();

  // The campaign page: header and the links table with their UTM values.
  await expect(page.getByRole("heading", { name: "E2E Spring" })).toBeVisible();
  const table = page.getByRole("table", { name: "Links" });
  await expect(table.getByRole("row")).toHaveCount(3);
  const news = table.getByRole("row").filter({ hasText: "/e2e-spring-news" });
  await expect(news.getByRole("cell")).toHaveText(["/e2e-spring-news", "Newsletter", "email", "—", "—", "0"]);
  await expect(table.getByRole("row").filter({ hasText: "instagram" })).toContainText("story a");

  const composed =
    `http://127.0.0.1:${PORT}/robots.txt?from=campaign` +
    "&utm_source=Newsletter&utm_medium=email&utm_campaign=E2E%20Spring#top";
  const res = await page.request.get("/e2e-spring-news", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toBe(composed);
  await page.goto("/e2e-spring-news");
  await expect(page).toHaveURL(composed);

  // The list shows the campaign with its link count and lifetime total (the two visits above).
  await page.goto("/admin/campaigns");
  const row = page.getByRole("table", { name: "Campaigns" }).getByRole("row").filter({ hasText: "E2E Spring" });
  await expect(row.getByRole("cell")).toHaveText(["E2E Spring", "E2E Spring", "2", "2"]);
});

test("11. open the campaign page without an analytics token: lifetime total and comparison, folded by medium", async () => {
  const res = await page.request.get("/api/v1/campaigns?q=E2E%20Spring");
  const id = ((await res.json()) as { items: { id: string }[] }).items[0]?.id ?? "";
  const stats = await page.request.get(`/api/v1/campaigns/${id}/stats?range=7d&tz=Asia/Seoul`);
  expect(stats.status()).toBe(503);
  expect(await stats.json()).toMatchObject({ error: { code: "analytics_unavailable" } });

  await page.goto(`/admin/campaigns/${id}`);
  await expect(page.getByRole("heading", { name: "E2E Spring" })).toBeVisible();
  await expect(page.getByRole("note", { name: "Estimates unavailable" })).toContainText("no analytics token");
  await expect(page.getByRole("tablist", { name: "Range" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Clicks" })).toHaveCount(0);
  // The combined lifetime total (the two visits of flow 10) stays, and the comparison runs on lifetime totals.
  const overview = page.getByLabel("Overview");
  await expect(overview.getByRole("definition").first()).toHaveText("2");
  await expect(page.getByRole("table", { name: "Links" }).getByRole("row").filter({ hasText: "/e2e-spring-news" }).getByRole("cell").last()).toHaveText("2");

  // Folded by medium from the rows at hand, ignoring case.
  await page.getByRole("tablist", { name: "Fold" }).getByRole("tab", { name: "By medium" }).click();
  const byMedium = page.getByRole("table", { name: "Links by medium" });
  await expect(byMedium.getByRole("row")).toHaveCount(3);
  await expect(byMedium.getByRole("row").nth(1).getByRole("cell")).toHaveText(["email", "1", "2"]);
  await expect(byMedium.getByRole("row").nth(2).getByRole("cell")).toHaveText(["social", "1", "0"]);
  await page.getByRole("tab", { name: "By source" }).click();
  await expect(page.getByRole("table", { name: "Links by source" }).getByRole("row").nth(1)).toContainText("Newsletter");
});
