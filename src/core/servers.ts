/**
 * Server / base-URL resolution for the apibear parser.
 *
 * Server selection is deliberately simple: the first server of the operation,
 * then of the path item, then of the document wins. Server variables are
 * substituted from their `default`, falling back to the first `enum` entry.
 * Relative URLs and missing/invalid servers resolve to `null` with a warning
 * instead of a guessed origin.
 *
 * Every function here is pure: the caller's document fragments are never
 * mutated, and no Node-only APIs are used.
 */

import type { ParserWarning } from "./types.js";

/**
 * Outcome of resolving one `servers` entry to a usable base URL.
 */
export interface BaseUrlResolution {
  /** Absolute base URL with variables substituted, or `null` when unusable. */
  baseUrl: string | null;
  /** Non-fatal problem explaining a `null` base URL, when one applies. */
  warning?: ParserWarning;
}

/** Absolute-URL shape: a scheme followed by `://`. */
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Matches one `{variable}` placeholder inside a server URL. */
const SERVER_VARIABLE_PATTERN = /\{([^{}]+)\}/g;

/**
 * Narrow an unknown value to a plain (non-array, non-null) object.
 *
 * @param value - Value to inspect.
 * @returns `true` when `value` is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `container.servers[0]` without assuming the container is well-formed.
 *
 * @param container - A document, path item, or operation object (may be invalid).
 * @returns The first server entry, or `undefined` when none is declared.
 */
function firstServer(container: unknown): unknown {
  if (!isRecord(container)) {
    return undefined;
  }
  const servers = container.servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    return undefined;
  }
  return servers[0];
}

/**
 * Pick the server entry that applies to one operation.
 *
 * Precedence, in order:
 * `operation.servers[0] ?? pathItem.servers[0] ?? doc.servers[0]`.
 * Nullish entries fall through to the next level, matching the `??` semantics
 * in the specification.
 *
 * @param operation - The operation object (may be invalid or absent).
 * @param pathItem - The containing path item (may be invalid or absent).
 * @param doc - The root OpenAPI document (may be invalid or absent).
 * @returns The selected raw server entry, or `undefined` when no level declares one.
 *
 * @example
 * ```ts
 * pickServer(operation, pathItem, doc); // operation.servers[0] ?? pathItem.servers[0] ?? doc.servers[0]
 * ```
 */
export function pickServer(operation: unknown, pathItem: unknown, doc: unknown): unknown {
  return firstServer(operation) ?? firstServer(pathItem) ?? firstServer(doc);
}

/**
 * Substitute every `{variable}` placeholder in a server URL.
 *
 * A variable resolves to its string `default` when present, otherwise to the
 * first `enum` entry when that entry is a string. Any unresolvable variable
 * aborts substitution and produces a `no-server-url` warning, because a
 * partially substituted URL is not usable as a base URL.
 *
 * @param url - Raw server URL, possibly containing `{variable}` placeholders.
 * @param variables - The server's `variables` object (may be invalid or absent).
 * @returns The substituted URL, or a warning describing the first bad variable.
 */
function substituteVariables(
  url: string,
  variables: unknown,
): { url: string } | { warning: ParserWarning } {
  let substituted = url;

  for (const match of url.matchAll(SERVER_VARIABLE_PATTERN)) {
    const name = match[1];
    if (name === undefined || name === "") {
      continue;
    }

    const definition =
      isRecord(variables) && Object.prototype.hasOwnProperty.call(variables, name)
        ? variables[name]
        : undefined;

    let replacement: string | undefined;
    if (isRecord(definition)) {
      if (typeof definition.default === "string") {
        replacement = definition.default;
      } else if (Array.isArray(definition.enum) && typeof definition.enum[0] === "string") {
        replacement = definition.enum[0];
      }
    }

    if (replacement === undefined) {
      return {
        warning: {
          code: "no-server-url",
          message: `Server variable "${name}" has no default or enum value; baseUrl is null.`,
        },
      };
    }

    substituted = substituted.split(`{${name}}`).join(replacement);
  }

  return { url: substituted };
}

/**
 * Resolve a raw `servers` entry to an absolute base URL.
 *
 * Behavior:
 * - Missing or malformed server entries yield `baseUrl: null` with a
 *   `no-server-url` warning.
 * - `{variable}` placeholders use the variable's `default`, else the first
 *   string `enum` entry; otherwise `null` + `no-server-url`.
 * - Relative URLs such as `/api/v3` yield `null` + `relative-server-url`, so the
 *   runner can ask the caller for an explicit `--base-url`.
 * - Absolute URLs are returned verbatim after substitution.
 *
 * The function never mutates the server object.
 *
 * @param server - A raw `servers` entry (any value; validated internally).
 * @returns The base URL (or `null`) plus an optional warning.
 *
 * @example
 * ```ts
 * resolveBaseUrl({ url: "https://petstore.example.com/api/v3" });
 * // { baseUrl: "https://petstore.example.com/api/v3" }
 * resolveBaseUrl({ url: "/api/v3" });
 * // { baseUrl: null, warning: { code: "relative-server-url", ... } }
 * ```
 */
export function resolveBaseUrl(server: unknown): BaseUrlResolution {
  if (!isRecord(server) || typeof server.url !== "string" || server.url.length === 0) {
    return {
      baseUrl: null,
      warning: {
        code: "no-server-url",
        message: "No server URL is defined; baseUrl is null.",
      },
    };
  }

  const substituted = substituteVariables(server.url, server.variables);
  if ("warning" in substituted) {
    return { baseUrl: null, warning: substituted.warning };
  }

  if (!ABSOLUTE_URL_PATTERN.test(substituted.url)) {
    return {
      baseUrl: null,
      warning: {
        code: "relative-server-url",
        message: `Server URL "${substituted.url}" is relative; baseUrl is null.`,
      },
    };
  }

  return { baseUrl: substituted.url };
}
