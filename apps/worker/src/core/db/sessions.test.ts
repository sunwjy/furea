import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deleteSession, findSession, insertSession, purgeExpiredSessions } from "./sessions.ts";

const NOW = new Date("2026-10-07T00:00:00.000Z");
const LATER = new Date("2026-11-06T00:00:00.000Z");

describe("sessions", () => {
  it("stores a session and finds it before it expires", async () => {
    await insertSession(env.DB, { idHash: "hash-live", now: NOW, expiresAt: LATER });
    expect(await findSession(env.DB, "hash-live", NOW)).toEqual({
      id_hash: "hash-live",
      created_at: "2026-10-07T00:00:00.000Z",
      expires_at: "2026-11-06T00:00:00.000Z",
    });
  });

  it("does not find a session at or after its expiry", async () => {
    await insertSession(env.DB, { idHash: "hash-expiring", now: NOW, expiresAt: LATER });
    expect(await findSession(env.DB, "hash-expiring", LATER)).toBeNull();
    expect(await findSession(env.DB, "hash-expiring", new Date("2026-12-01T00:00:00.000Z"))).toBeNull();
  });

  it("returns null for an unknown hash", async () => {
    expect(await findSession(env.DB, "hash-unknown", NOW)).toBeNull();
  });

  it("deletes one session", async () => {
    await insertSession(env.DB, { idHash: "hash-gone", now: NOW, expiresAt: LATER });
    await insertSession(env.DB, { idHash: "hash-kept", now: NOW, expiresAt: LATER });
    await deleteSession(env.DB, "hash-gone");
    expect(await findSession(env.DB, "hash-gone", NOW)).toBeNull();
    expect(await findSession(env.DB, "hash-kept", NOW)).not.toBeNull();
  });

  it("purges exactly the expired rows", async () => {
    const past = new Date("2026-09-01T00:00:00.000Z");
    await insertSession(env.DB, { idHash: "hash-old", now: past, expiresAt: new Date("2026-10-01T00:00:00.000Z") });
    await insertSession(env.DB, { idHash: "hash-edge", now: past, expiresAt: NOW });
    await insertSession(env.DB, { idHash: "hash-fresh", now: NOW, expiresAt: LATER });

    await purgeExpiredSessions(env.DB, NOW);

    const left = await env.DB.prepare("SELECT id_hash FROM sessions WHERE id_hash IN ('hash-old', 'hash-edge', 'hash-fresh')").all<{ id_hash: string }>();
    expect(left.results.map((r) => r.id_hash)).toEqual(["hash-fresh"]);
  });
});
