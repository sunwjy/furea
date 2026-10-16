import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useFixture } from "../../test/fixtures.ts";
import { fakeTerminal } from "../../test/terminal.ts";
import { runCli } from "../cli.ts";

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

async function domain(scenario: string, argv: string[]) {
  const api = useFixture(scenario, { accountEnv: "CLOUDFLARE_ACCOUNT_ID" });
  const sent: Sent[] = [];
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return api.fetch(input, init);
  }) as typeof fetch;
  const terminal = fakeTerminal({ interactive: false });
  const code = await runCli(["domain", ...argv], {
    fetch: spy,
    env: { CLOUDFLARE_API_TOKEN: api.token, CLOUDFLARE_ACCOUNT_ID: api.accountId! },
    configDir: mkdtempSync(join(tmpdir(), "furea-cli-")),
    io: terminal,
  });
  return { code, terminal, sent, api };
}

const scriptUploaded = (sent: Sent[]) => sent.some((s) => s.method === "PUT" && s.url.endsWith("/workers/scripts/furea"));

describe("domain", () => {
  it("set attaches the hostname without re-uploading the script and then disables workers.dev", async () => {
    const { code, terminal, sent, api } = await domain("domain-set", ["set", "s.example.com"]);

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.stdout).toEqual([
      "domain  create  https://s.example.com",
      "workers.dev  skip  disabled; the instance answers on s.example.com",
      "Ready: https://s.example.com/admin/",
    ]);
    expect(sent.find((s) => s.method === "PUT")!.body).toEqual({ hostname: "s.example.com", service: "furea", zone_id: "ID_4" });
    expect(sent.at(-1)!.body).toEqual({ enabled: false, previews_enabled: false });
    expect(scriptUploaded(sent)).toBe(false);
    api.done();
  });

  it("set replaces a previous hostname only after the new one is attached", async () => {
    const { code, terminal, sent, api } = await domain("domain-set-replace", ["set", "s.example.com"]);

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.stdout[0]).toBe("domain  create  https://s.example.com (replaces old.example.com)");
    const order = sent.map((s) => s.method);
    expect(order.indexOf("PUT")).toBeLessThan(order.indexOf("DELETE"));
    api.done();
  });

  it("set stops on a hostname another Worker already holds and changes nothing", async () => {
    const { code, terminal, sent, api } = await domain("domain-set-conflict", ["set", "s.example.com"]);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toContain('s.example.com is already attached to the Worker "blog"');
    expect(sent.every((s) => s.method === "GET")).toBe(true);
    api.done();
  });

  it("unset brings workers.dev back first, then detaches the custom domain", async () => {
    const { code, terminal, sent, api } = await domain("domain-unset", ["unset"]);

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(terminal.stdout).toEqual([
      "workers.dev  create  https://furea.SUBDOMAIN_1.workers.dev",
      "domain  skip  detached s.example.com",
      "Ready: https://furea.SUBDOMAIN_1.workers.dev/admin/",
    ]);
    expect(sent.map((s) => s.method).slice(-2)).toEqual(["POST", "DELETE"]);
    expect(scriptUploaded(sent)).toBe(false);
    api.done();
  });

  it("needs a deployed instance", async () => {
    const { code, terminal, api } = await domain("domain-no-instance", ["set", "s.example.com"]);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toContain('No instance named "furea" in this account; run npx furea deploy first.');
    api.done();
  });

  it("names the subcommands when none is given", async () => {
    const { code, terminal } = await domain("domain-no-instance", []);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toContain("domain set <hostname>");
  });
});
