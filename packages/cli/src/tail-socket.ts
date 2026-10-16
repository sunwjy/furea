// The tail's `trace-v1` WebSocket and the timer that renews the tail, as seams: `furea logs` is tested with
// sockets and timers the test drives. The real transport is Node's global WebSocket (Node 22+), so the published
// CLI stays free of runtime dependencies (ADR 0007). The tail URL is the capability; no header is sent.

import { CliError } from "./io.ts";

export interface TailSocket {
  send(text: string): void;
  close(): void;
}

export interface TailTransport {
  /** Resolves once the socket is open; `close` fires once when it closes for any reason, `close()` included. */
  connect(url: string, on: { message(text: string): void; close(): void }): Promise<TailSocket>;
}

export interface Clock {
  now(): number;
  /** Returns a cancel function. */
  setTimeout(fire: () => void, ms: number): () => void;
}

/** Node's timers cap a delay at 2^31-1 ms; a tail never lives that long, but a longer wait is re-armed anyway. */
const MAX_DELAY = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fire, ms) {
    let handle: ReturnType<typeof setTimeout>;
    const arm = (remaining: number) => {
      handle = setTimeout(() => (remaining > MAX_DELAY ? arm(remaining - MAX_DELAY) : fire()), Math.min(remaining, MAX_DELAY));
    };
    arm(Math.max(0, ms));
    return () => clearTimeout(handle);
  },
};

export const webSocketTransport: TailTransport = {
  connect(url, on) {
    if (typeof globalThis.WebSocket !== "function") {
      return Promise.reject(new CliError("furea logs needs Node.js 22 or newer (for its built-in WebSocket)."));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, "trace-v1");
      ws.binaryType = "arraybuffer";
      let open = false;
      const decoder = new TextDecoder();
      ws.addEventListener("open", () => {
        open = true;
        resolve({ send: (text) => ws.send(text), close: () => ws.close() });
      });
      ws.addEventListener("message", (event: MessageEvent) => {
        on.message(typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer));
      });
      ws.addEventListener("close", () => {
        if (open) on.close();
        else reject(new CliError("Could not connect to the log tail; try again."));
      });
    });
  },
};
