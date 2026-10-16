import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgainst, runOffline, type Sent } from "../../test/run.ts";
import { CredentialsFile } from "../credentials.ts";

const A = "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID";

const deletes = (sent: Sent[]) => sent.filter((s) => s.method === "DELETE").map((s) => s.url);

describe("destroy", () => {
  it("deletes custom domain, Worker, KV namespace and D1 database once the instance name is typed", async () => {
    const { code, terminal, sent, api } = await runAgainst("destroy", ["destroy"], { interactive: true, answers: ["furea"] });

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.questions).toEqual(['Type the instance name ("furea") to delete it: ']);
    expect(deletes(sent)).toEqual([
      `${A}/workers/domains/ID_5`,
      `${A}/workers/scripts/furea`,
      `${A}/storage/kv/namespaces/ID_2`,
      `${A}/d1/database/ID_1`,
    ]);
    expect(terminal.stdout).toEqual(
      expect.arrayContaining([
        "domain  delete  host-2.example.com",
        "script  delete  furea",
        "kv  delete  furea (ID_2)",
        "database  delete  furea (ID_1)",
      ]),
    );
    api.done();
  });

  it("deletes nothing when the typed name does not match", async () => {
    const { code, terminal, sent, api } = await runAgainst("destroy-declined", ["destroy"], { interactive: true, answers: ["fure"] });

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/does not match "furea"; nothing was deleted/);
    expect(deletes(sent)).toEqual([]);
    api.done();
  });

  it("keeps the D1 database with --keep-database, confirmed with --confirm when nothing can be asked", async () => {
    const { code, terminal, sent, api } = await runAgainst("destroy-keep-database", ["destroy", "--keep-database", "--confirm", "furea"]);

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(deletes(sent)).toEqual([`${A}/workers/scripts/furea`, `${A}/storage/kv/namespaces/ID_2`]);
    expect(terminal.stdout).toEqual(
      expect.arrayContaining(["domain  skip  none attached", "database  keep  furea (ID_1), kept by --keep-database"]),
    );
    api.done();
  });

  it("leaves the stored deploy token in place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "furea-cli-"));
    new CredentialsFile(dir).set("ACCOUNT_ID", "TOKEN");
    const before = readFileSync(join(dir, "credentials.json"), "utf8");

    const { code, terminal, api } = await runAgainst("destroy", ["destroy", "--account", "ACCOUNT_ID", "--confirm", "furea"], {
      configDir: dir,
      env: { CLOUDFLARE_API_TOKEN: "" },
    });

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "credentials.json"), "utf8")).toBe(before);
    expect(terminal.stdout.join("\n")).toMatch(/npx furea logout/);
    api.done();
  });

  it("reports that nothing exists under the name, without asking", async () => {
    const { code, terminal, sent, api } = await runAgainst("destroy-nothing", ["destroy"], { interactive: true });

    expect(code).toBe(0);
    expect(terminal.questions).toEqual([]);
    expect(terminal.stdout.join("\n")).toMatch(/Nothing named "furea" in account ACCOUNT_ID/);
    expect(deletes(sent)).toEqual([]);
    api.done();
  });

  it("refuses a --confirm that is not the instance name before calling Cloudflare", async () => {
    const { code, terminal } = await runOffline(["destroy", "--confirm", "other"]);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/--confirm/);
  });

  it("names --confirm when it cannot ask", async () => {
    const { code, terminal } = await runOffline(["destroy"]);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/--confirm furea/);
  });
});
