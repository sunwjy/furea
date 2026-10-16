// `POST /password` (ADR 0009, *Settings*; ADR 0003, *Operator password*): rotation after re-entering the current
// password. Session only, and it logs out everywhere, this browser included.

import { ChangePasswordRequest, hashPassword, verifyPassword } from "@furea/shared";
import { Hono } from "hono";
import { deleteAllSessions } from "../core/db/sessions.ts";
import { getSetting, setSetting } from "../core/db/settings.ts";
import type { ApiEnv } from "./context.ts";
import { apiError } from "./errors.ts";
import { clearedSessionCookie, FAILED_LOGIN_DELAY_MS, requireSession } from "./session.ts";
import { jsonBody } from "./validate.ts";

export const password = new Hono<ApiEnv>();

password.post("/", requireSession, jsonBody(ChangePasswordRequest), async (c) => {
  const { currentPassword, newPassword } = c.var.body;
  const stored = await getSetting(c.env.DB, "operator_password_hash");
  // The same answer and delay as a failed login: a stolen session must not make guessing cheaper.
  if (stored === null || !(await verifyPassword(currentPassword, stored))) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return apiError(401, "invalid_password", "The current password is not correct.");
  }
  await setSetting(c.env.DB, "operator_password_hash", await hashPassword(newPassword));
  await deleteAllSessions(c.env.DB);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearedSessionCookie(), "Cache-Control": "no-store" },
  });
});
