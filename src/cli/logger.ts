/**
 * stderr-only logger.
 *
 * STDOUT IS THE MCP TRANSPORT: log lines must never reach it or they corrupt
 * the JSON-RPC stream. Every helper here writes exactly one line to
 * `process.stderr`.
 */

const PREFIX = "[apibear]";

function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Log an informational message to stderr. */
export function log(message: string): void {
  write(`${PREFIX} ${message}`);
}

/** Log a warning to stderr. */
export function warn(message: string): void {
  write(`${PREFIX} warning: ${message}`);
}

/** Log an error to stderr. Never logs header values — callers must redact them. */
export function error(message: string | Error | unknown): void {
  const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message);
  write(`${PREFIX} error: ${text}`);
}
