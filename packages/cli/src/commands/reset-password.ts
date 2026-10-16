// `furea reset-password`: recovery without the old password (ADR 0003). Access to the Cloudflare account is the
// proof of ownership, so the fresh hash goes straight into D1 through the REST API.

import { hashPassword } from "@furea/shared/password";
import { randomAlphabetString } from "@furea/shared/slug";
import type { CommandContext } from "../context.ts";
import { connect, instanceDatabase } from "../instance.ts";
import { OPERATOR_PASSWORD_LENGTH } from "./deploy.ts";

export async function resetPassword(ctx: CommandContext): Promise<void> {
  const connection = await connect(ctx);
  const { client, accountId } = connection;
  const database = await instanceDatabase(ctx, connection);

  const password = randomAlphabetString(OPERATOR_PASSWORD_LENGTH);
  await client.d1Query(
    accountId,
    database.uuid,
    "INSERT INTO settings (key, value) VALUES ('operator_password_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [await hashPassword(password)],
  );
  // After the hash, so no session can be opened with the old password once this has run.
  const [deleted] = await client.d1Query(accountId, database.uuid, "DELETE FROM sessions");
  const sessions = deleted?.meta?.changes ?? 0;

  ctx.io.out(`New operator password: ${password}  (shown only this once; store it now)`);
  ctx.io.out(`Signed out ${sessions} session${sessions === 1 ? "" : "s"}.`);
}
