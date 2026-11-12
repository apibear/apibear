/**
 * CLI argument parsing (task 2.2).
 *
 * This module is deliberately pure: it never reads or writes stdout/stderr,
 * never calls `process.exit`, and never touches the filesystem; the environment
 * used for `${VAR}` header expansion is injected by the caller. Stdout is the
 * MCP transport, so the caller (cli.ts) owns all output and exit codes.
 *
 * Header values may contain secrets (tokens). Error messages must never echo
 * a raw `--header` value; at most a parsed header *name* may appear.
 */

import { parseArgs } from "node:util";

import { UsageError } from "./errors.js";
import { VERSION } from "./version.js";

/** Valid HTTP header field-name (RFC 7230 `token`). */
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const HEADER_SHAPE_MESSAGE =
  '--header must look like "Name: Value" (an entry is missing ":" or has an empty name)';

/** Environment lookup used for `${VAR}` expansion in `--header` values. */
export type Env = Record<string, string | undefined>;

/** `$${` (escaped literal) or `${NAME}` (environment reference). */
const ENV_REFERENCE_RE = /\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Normalized options for a server run. */
export interface RunnerOptions {
  spec: string;
  headers: Record<string, string>;
  only?: string[];
  baseUrl?: string;
  timeoutMs: number;
  listTools: boolean;
}

/** Result of parsing argv; `error` means the caller should exit with code 2. */
export type ParsedArgs =
  | { kind: "run"; options: RunnerOptions }
  | { kind: "help"; text: string }
  | { kind: "version"; text: string }
  | { kind: "error"; message: string };

/** Usage text printed for `--help`. */
export const HELP_TEXT: string = [
  "apibear --spec <path|url> [options]",
  "",
  "Required:",
  "  --spec <path|url>          OpenAPI 3.x file (JSON or YAML) or http(s) URL",
  "",
  "Options:",
  "  --header <Name:Value>      Header to inject into every upstream request. Repeatable.",
  '                             e.g. --header "Authorization: Bearer sk-123" --header "x-api-key: abc"',
  "                             ${VAR} in a value is read from the environment ($${ is a",
  '                             literal "${"), e.g. --header "Authorization: Bearer ${API_TOKEN}"',
  "  --only <id,id,...>         Comma-separated operationIds to expose (context-window control).",
  "                             Unknown ids are ignored; a warning is printed to stderr.",
  "  --base-url <url>           Override the spec's server URL (mandatory when the spec has no",
  "                             usable absolute server URL).",
  "  --timeout <ms>             Upstream request timeout in milliseconds. Default 30000.",
  "  --list-tools               Print tool names + one-line descriptions to stdout and exit 0",
  "                             without starting the MCP server.",
  "  -h, --help                 Show this help text and exit 0.",
  "  --version                  Print the version and exit 0.",
  "",
  "Logs go to stderr; stdout carries the MCP protocol (except for --list-tools).",
  "",
  "Exit codes:",
  "  0  success (including --help, --version, and --list-tools)",
  "  2  usage or spec-load error",
  "  1  unexpected runtime crash",
].join("\n");

/** Split a `Name:Value` header argument on the first colon. Throws {@link UsageError}. */
export function parseHeader(raw: string): { name: string; value: string } {
  const colon = raw.indexOf(":");
  if (colon === -1) {
    // Never include `raw`: it may hold an auth token (e.g. a typo missing ":").
    throw new UsageError(HEADER_SHAPE_MESSAGE);
  }

  const name = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();

  if (name.length === 0) {
    throw new UsageError(HEADER_SHAPE_MESSAGE);
  }
  if (!HTTP_TOKEN_RE.test(name)) {
    // The name was already separated from any value, so mentioning it is safe.
    throw new UsageError(`--header name "${name}" is not a valid HTTP header name`);
  }

  return { name, value };
}

/**
 * Expand `${NAME}` references in a header value from `env`; `$${` yields a
 * literal `${`. Throws {@link UsageError} naming the header and variable (never
 * the value) when a referenced variable is unset or empty.
 */
export function expandEnvReferences(headerName: string, value: string, env: Env): string {
  return value.replace(ENV_REFERENCE_RE, (_match, variable: string | undefined) => {
    if (variable === undefined) {
      return "${";
    }
    const resolved = env[variable];
    if (resolved === undefined || resolved === "") {
      throw new UsageError(
        `--header "${headerName}" references environment variable ${variable}, which is not set`,
      );
    }
    return resolved;
  });
}

/** Collect literal `--header` values so they can be scrubbed from thrown messages. */
function headerArgumentValues(argv: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--header") {
      const next = argv[index + 1];
      if (next !== undefined) {
        values.push(next);
      }
    } else if (arg.startsWith("--header=")) {
      values.push(arg.slice("--header=".length));
    }
  }
  return values;
}

/** Strip any raw header value from a parse error message. */
function redactHeaderValues(message: string, argv: string[]): string {
  let redacted = message;
  for (const raw of headerArgumentValues(argv)) {
    if (raw.length > 0 && redacted.includes(raw)) {
      redacted = redacted.split(raw).join("<redacted>");
    }
  }
  return redacted;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return String(cause);
}

/**
 * Map a thrown parseArgs error to the message the caller should show.
 *
 * `parseArgs` refuses a dash-leading value (`--timeout -5`) as "ambiguous"
 * before our own validation can run; normalize that one to the documented
 * timeout message so every bad timeout reads the same.
 */
function normalizeParseError(cause: unknown, argv: string[]): string {
  const message = errorMessage(cause);
  if (/^Option '--timeout' argument is ambiguous/.test(message)) {
    return "--timeout must be a positive integer (milliseconds)";
  }
  return redactHeaderValues(message, argv);
}

/** Parse a comma-separated `--only` list: trim, drop empties, dedupe (first wins). */
function parseOnlyList(raw: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Parse argv without I/O or `process.exit`. Pure: the environment used for
 * `${VAR}` expansion in `--header` values is passed in (default `process.env`).
 */
export function parseCliArgs(argv: string[], env: Env = process.env): ParsedArgs {
  // Help/version win over everything else, even a malformed remainder.
  if (argv.includes("--help") || argv.includes("-h")) {
    return { kind: "help", text: HELP_TEXT };
  }
  if (argv.includes("--version")) {
    return { kind: "version", text: VERSION };
  }

  let values: {
    spec?: string;
    "base-url"?: string;
    timeout?: string;
    only?: string;
    header?: string[];
    "list-tools"?: boolean;
    help?: boolean;
    h?: boolean;
    version?: boolean;
  };

  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        spec: { type: "string" },
        "base-url": { type: "string" },
        timeout: { type: "string" },
        only: { type: "string" },
        header: { type: "string", multiple: true },
        "list-tools": { type: "boolean" },
        help: { type: "boolean" },
        h: { type: "boolean" },
        version: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
      allowNegative: false,
    });
    values = parsed.values;
  } catch (cause) {
    return {
      kind: "error",
      message: normalizeParseError(cause, argv),
    };
  }

  const spec = values.spec;
  if (spec === undefined || spec.trim().length === 0) {
    return { kind: "error", message: "--spec is required" };
  }

  let headers: Record<string, string>;
  try {
    headers = parseHeaders(values.header ?? [], env);
  } catch (cause) {
    if (cause instanceof UsageError) {
      return { kind: "error", message: cause.message };
    }
    throw cause;
  }

  let only: string[] | undefined;
  if (values.only !== undefined) {
    only = parseOnlyList(values.only);
    if (only.length === 0) {
      return { kind: "error", message: "--only needs at least one operationId" };
    }
  }

  let baseUrl: string | undefined;
  if (values["base-url"] !== undefined) {
    baseUrl = values["base-url"];
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      return { kind: "error", message: "--base-url must be an absolute http(s) URL" };
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return { kind: "error", message: "--base-url must be an absolute http(s) URL" };
    }
  }

  let timeoutMs = 30000;
  if (values.timeout !== undefined) {
    if (!/^\d+$/.test(values.timeout)) {
      return {
        kind: "error",
        message: "--timeout must be a positive integer (milliseconds)",
      };
    }
    const parsedTimeout = Number(values.timeout);
    if (!Number.isSafeInteger(parsedTimeout) || parsedTimeout < 1) {
      return {
        kind: "error",
        message: "--timeout must be a positive integer (milliseconds)",
      };
    }
    timeoutMs = parsedTimeout;
  }

  const options: RunnerOptions = {
    spec,
    headers,
    timeoutMs,
    listTools: values["list-tools"] === true,
  };
  if (only !== undefined) {
    options.only = only;
  }
  if (baseUrl !== undefined) {
    options.baseUrl = baseUrl;
  }

  return { kind: "run", options };
}

/**
 * Build the header map. Names are compared case-insensitively; the last
 * occurrence wins and its casing is the one kept. Values have `${VAR}`
 * references expanded from `env`.
 */
function parseHeaders(rawHeaders: string[], env: Env): Record<string, string> {
  const headers: Record<string, string> = {};
  const canonicalName = new Map<string, string>();

  for (const raw of rawHeaders) {
    const parsed = parseHeader(raw);
    const name = parsed.name;
    const value = expandEnvReferences(name, parsed.value, env);
    const lower = name.toLowerCase();
    const previous = canonicalName.get(lower);
    if (previous !== undefined && previous !== name) {
      delete headers[previous];
    }
    canonicalName.set(lower, name);
    headers[name] = value;
  }

  return headers;
}
