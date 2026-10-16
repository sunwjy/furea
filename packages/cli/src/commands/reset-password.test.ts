import { verifyPassword } from "@furea/shared";
import { describe, expect, it } from "vitest";
import { d1Queries, runAgainst } from "../../test/run.ts";

describe("reset-password", () => {
  it("writes a fresh hash into D1, deletes every session and prints the new password once", async () => {
    const { code, terminal, sent, api } = await runAgainst("reset-password", ["reset-password"]);

    expect(terminal.stderr).toEqual([]);
    expect(code).toBe(0);
    const [hashWrite, sessions] = d1Queries(sent);
    expect(hashWrite!.sql).toBe(
      "INSERT INTO settings (key, value) VALUES ('operator_password_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    expect(sessions!.sql).toBe("DELETE FROM sessions");

    const output = terminal.stdout.join("\n");
    const printed = output.match(/New operator password: (\S+)/)?.[1];
    expect(printed).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(output.split(printed!)).toHaveLength(2);
    expect(await verifyPassword(printed!, String(hashWrite!.params![0]))).toBe(true);
    expect(output).toContain("Signed out 3 sessions.");
    api.done();
  });

  it("refuses when there is no instance of that name, writing nothing", async () => {
    const { code, terminal, sent, api } = await runAgainst("reset-password-no-instance", ["reset-password"]);

    expect(code).toBe(1);
    expect(terminal.stderr.join("\n")).toMatch(/No furea instance named "furea"/);
    expect(d1Queries(sent)).toEqual([]);
    api.done();
  });
});
