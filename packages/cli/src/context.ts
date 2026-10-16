import type { CredentialsFile } from "./credentials.ts";
import type { Io } from "./io.ts";

/** What every command receives: injected effects plus the global flags. */
export interface CommandContext {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  io: Io;
  credentials: CredentialsFile;
  /** `--name`, default `furea`. */
  name: string;
  /** `--account`. */
  account: string | undefined;
}
