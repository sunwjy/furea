// What `furea logs` keeps of a tail trace event (ADR 0011). The event is reduced to an allow-list of fields
// before anything is printed: request headers, the client IP, `cf` fields, the host and the query string never
// leave this module, and there is no raw mode.

export interface LogLine {
  /** ISO 8601, UTC. */
  time: string;
  /** `ok`, `exception`, `exceededCpu`, `canceled`, ... as the tail reports it. */
  outcome: string;
  method?: string;
  /** The request path without its query string. */
  path?: string;
  /** The schedule of a Cron Trigger event, which has no request. */
  cron?: string;
  logs: Array<{ level: string; message: string }>;
  exceptions: Array<{ name: string; message: string }>;
}

interface TraceEvent {
  outcome?: unknown;
  eventTimestamp?: unknown;
  logs?: Array<{ level?: unknown; message?: unknown }>;
  exceptions?: Array<{ name?: unknown; message?: unknown }>;
  event?: { request?: { url?: unknown; method?: unknown }; cron?: unknown } | null;
}

const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** One `trace-v1` WebSocket message as a log line, or undefined when it is not a trace event. */
export function toLogLine(message: string): LogLine | undefined {
  let event: TraceEvent;
  try {
    event = JSON.parse(message) as TraceEvent;
  } catch {
    return undefined;
  }
  if (!event || typeof event !== "object" || typeof event.outcome !== "string" || typeof event.eventTimestamp !== "number") {
    return undefined;
  }
  const line: LogLine = { time: new Date(event.eventTimestamp).toISOString(), outcome: event.outcome, logs: [], exceptions: [] };
  const request = event.event?.request;
  if (request && typeof request.url === "string") {
    if (typeof request.method === "string") line.method = request.method;
    try {
      line.path = new URL(request.url).pathname;
    } catch {
      // An unparseable URL shows no path rather than risking its query.
    }
  } else if (typeof event.event?.cron === "string") {
    line.cron = event.event.cron;
  }
  line.logs = (Array.isArray(event.logs) ? event.logs : []).map((log) => ({
    level: typeof log.level === "string" ? log.level : "log",
    message: (Array.isArray(log.message) ? log.message : [log.message]).map(text).join(" "),
  }));
  line.exceptions = (Array.isArray(event.exceptions) ? event.exceptions : []).map((exception) => ({
    name: typeof exception.name === "string" ? exception.name : "Error",
    message: typeof exception.message === "string" ? exception.message : text(exception.message),
  }));
  return line;
}

/** `--errors`: an outcome other than `ok`, or an exception. */
export function isError(line: LogLine): boolean {
  return line.outcome !== "ok" || line.exceptions.length > 0;
}

/** The human form: one heading line per event, its log lines and exceptions indented below. */
export function formatLine(line: LogLine): string {
  const what = line.cron !== undefined ? `cron ${line.cron}` : [line.method, line.path].filter(Boolean).join(" ");
  return [
    [line.time, line.outcome, what].filter(Boolean).join("  "),
    ...line.logs.map((log) => `  ${log.level}  ${log.message}`),
    ...line.exceptions.map((exception) => `  exception  ${exception.name}: ${exception.message}`),
  ].join("\n");
}
