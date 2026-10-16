// Entry point of the published CLI: wires the real network, environment and terminal into runCli.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { runCli } from "./cli.ts";
import { defaultConfigDir } from "./credentials.ts";
import type { Io } from "./io.ts";

function prompt(question: string, options?: { secret?: boolean }): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (options?.secret) {
    // Echo the question, then nothing of what is typed.
    const internal = rl as unknown as { _writeToOutput(text: string): void };
    const write = internal._writeToOutput.bind(rl);
    internal._writeToOutput = (text) => {
      if (text.includes(question)) write(text);
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (options?.secret) process.stderr.write("\n");
      resolve(answer);
    });
  });
}

/** Best effort: the URL is always printed as well, so a missing opener only costs a copy-paste. */
async function openUrl(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed above; nothing else to do.
  }
}

const io: Io = {
  interactive: Boolean(process.stdin.isTTY),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  prompt,
  openUrl,
};

/** The first Ctrl-C (or SIGTERM) lets the command clean up; a second one exits at once. */
function untilInterrupted(): AbortSignal {
  const controller = new AbortController();
  const interrupt = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  return controller.signal;
}

process.exitCode = await runCli(process.argv.slice(2), {
  fetch: globalThis.fetch,
  env: process.env,
  configDir: defaultConfigDir(process.env),
  io,
  untilInterrupted,
});
