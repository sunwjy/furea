// The terminal as the commands see it. When stdin is not a TTY nothing is ever prompted:
// a value that would have been asked for fails with the flag or variable that supplies it (ADR 0006).

export interface Io {
  /** stdin is a TTY, so prompts are allowed. */
  interactive: boolean;
  out(line: string): void;
  err(line: string): void;
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
  openUrl(url: string): Promise<void>;
}

/** What a step of `deploy` (or a later command redoing one) did: one `<step>  <action>  <detail>` line (ADR 0006). */
export type Action = "create" | "reuse" | "skip";

export function step(io: Io, name: string, action: Action, detail: string): void {
  io.out(`${name}  ${action}  ${detail}`);
}

/** A user-facing failure: printed without a stack trace, exit code 1. */
export class CliError extends Error {
  override name = "CliError";
}

/** Asks for a value, or fails naming `supply` (a flag or environment variable) when prompting is not allowed. */
export async function ask(io: Io, question: string, supply: string, options?: { secret?: boolean }): Promise<string> {
  if (!io.interactive) throw new CliError(`Missing value: pass ${supply} (stdin is not a terminal, so nothing is prompted).`);
  const answer = (await io.prompt(question, options)).trim();
  if (answer === "") throw new CliError(`No value given; pass ${supply} instead.`);
  return answer;
}

/** Lets the operator pick one of several items by number; fails naming `supply` when not interactive. */
export async function choose<T>(io: Io, title: string, items: T[], label: (item: T) => string, supply: string): Promise<T> {
  if (!io.interactive) throw new CliError(`${title}: pass ${supply} (stdin is not a terminal, so nothing is prompted).`);
  io.out(`${title}:`);
  items.forEach((item, i) => io.out(`  ${i + 1}) ${label(item)}`));
  const answer = (await io.prompt(`Choose 1-${items.length}: `)).trim();
  const item = items[Number(answer) - 1];
  if (!/^\d+$/.test(answer) || item === undefined) throw new CliError(`"${answer}" is not one of 1-${items.length}; pass ${supply} instead.`);
  return item;
}
