// `furea logs`: a live tail of the instance (ADR 0011). Nothing is stored and nothing about visitors is shown:
// every trace event is reduced to `LogLine` before it is printed. The tail is recreated when it reaches
// `expires_at` (delivery just stops there) and deleted on exit.

import { CloudflareApiError, CloudflareClient, isNotFound, type Tail } from "../cloudflare/client.ts";
import type { CommandContext } from "../context.ts";
import { resolveDeployCredentials } from "../credentials.ts";
import { CliError } from "../io.ts";
import { formatLine, isError, toLogLine } from "../tail.ts";
import type { Clock, TailSocket, TailTransport } from "../tail-socket.ts";

export interface LogsOptions {
  /** `--errors`. */
  errors: boolean;
  /** `--json`. */
  json: boolean;
  transport: TailTransport;
  clock: Clock;
  /** Aborted on Ctrl-C. */
  stop: AbortSignal;
}

interface Session {
  tail: Tail;
  socket: TailSocket;
  /** Set before this side closes the socket, so the close is not taken for a dropped connection. */
  closing: boolean;
}

export async function logs(ctx: CommandContext, options: LogsOptions): Promise<void> {
  const { io, name } = ctx;
  const { token, accountId } = await resolveDeployCredentials(ctx);
  const client = new CloudflareClient({ token, fetch: ctx.fetch });

  const print = (message: string) => {
    const line = toLogLine(message);
    if (!line || (options.errors && !isError(line))) return;
    io.out(options.json ? JSON.stringify(line) : formatLine(line));
  };

  let finish!: (reason: "stop" | "dropped" | Error) => void;
  const ended = new Promise<"stop" | "dropped" | Error>((resolve) => (finish = resolve));

  const open = async (): Promise<Session> => {
    const tail = await createTail(client, accountId, name);
    const session: Session = { tail, socket: undefined as unknown as TailSocket, closing: false };
    try {
      session.socket = await options.transport.connect(tail.url, {
        message: print,
        close: () => {
          if (!session.closing) finish("dropped");
        },
      });
    } catch (error) {
      await client.deleteTail(accountId, name, tail.id).catch(() => {});
      throw error;
    }
    session.socket.send(JSON.stringify({ debug: false }));
    return session;
  };

  const close = async (session: Session) => {
    session.closing = true;
    session.socket.close();
    try {
      await client.deleteTail(accountId, name, session.tail.id);
    } catch (error) {
      // Already gone (expired and reaped): nothing to clean up.
      if (!isNotFound(error)) throw error;
    }
  };

  let session = await open();
  let cancelRenewal = () => {};
  const scheduleRenewal = () => {
    cancelRenewal = options.clock.setTimeout(() => {
      // The new tail is open before the old one goes, so no event falls between them.
      open()
        .then(async (next) => {
          const previous = session;
          session = next;
          scheduleRenewal();
          await close(previous);
        })
        .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    }, Date.parse(session.tail.expires_at) - options.clock.now());
  };
  scheduleRenewal();

  io.err(`Live tail of "${name}": events appear as they happen, and nothing is stored. Press Ctrl-C to stop.`);
  io.err(`Past logs: Cloudflare dashboard → Workers & Pages → ${name} → Observability.`);

  const stopped = () => finish("stop");
  if (options.stop.aborted) stopped();
  else options.stop.addEventListener("abort", stopped, { once: true });

  const reason = await ended;
  options.stop.removeEventListener("abort", stopped);
  cancelRenewal();
  await close(session);
  if (reason instanceof Error) throw reason;
  if (reason === "dropped") throw new CliError("The log tail connection closed. Run furea logs again to reconnect.");
}

async function createTail(client: CloudflareClient, accountId: string, name: string): Promise<Tail> {
  try {
    return await client.createTail(accountId, name);
  } catch (error) {
    if (isNotFound(error)) throw new CliError(`No instance named "${name}" on this account; check --name, or install it with npx furea deploy.`);
    if (isViewerLimit(error)) {
      throw new CliError(
        `Cloudflare allows 10 live log viewers per Worker at a time (dashboard sessions included), and "${name}" has them all. Close one and try again.`,
      );
    }
    throw error;
  }
}

/** The documented limit has no documented error code, so it is recognised by status or wording. */
function isViewerLimit(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 429 || error.errors.some((e) => /too many|maximum|limit|concurrent/i.test(e.message)))
  );
}
