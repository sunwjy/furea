// A scripted terminal for command tests: canned answers, captured output, recorded URL opens.

import type { Io } from "../src/io.ts";

export interface FakeTerminal extends Io {
  stdout: string[];
  stderr: string[];
  opened: string[];
  questions: string[];
}

export function fakeTerminal(options: { interactive: boolean; answers?: string[] }): FakeTerminal {
  const answers = [...(options.answers ?? [])];
  const terminal: FakeTerminal = {
    interactive: options.interactive,
    stdout: [],
    stderr: [],
    opened: [],
    questions: [],
    out: (line) => void terminal.stdout.push(line),
    err: (line) => void terminal.stderr.push(line),
    openUrl: async (url) => void terminal.opened.push(url),
    prompt: async (question) => {
      if (!options.interactive) throw new Error(`prompted while not interactive: ${question}`);
      terminal.questions.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no scripted answer for: ${question}`);
      return answer;
    },
  };
  return terminal;
}
