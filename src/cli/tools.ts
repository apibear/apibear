/**
 * OpenAPI → MCP tool list.
 *
 * Thin adapter over the core parser (`src/core`): applies `--only`, reports parser
 * warnings to stderr, and builds the name lookup used by the dispatcher.
 */

import { OpenApiParseError, parseOpenApiToTools } from "../core/index.js";
import type { ParsedTool, ParserWarning, ParseResult } from "../core/index.js";

import { UsageError } from "./errors.js";
import { log, warn } from "./logger.js";

/** Tools produced from a document, plus lookup and warning info. */
export interface LoadedTools {
  tools: ParsedTool[];
  byName: Map<string, ParsedTool>;
  api: { title: string; version: string; baseUrl: string | null };
  warnings: ParserWarning[];
}

/** Convert a dereferenced document into tools. Throws UsageError when zero tools result. */
export function buildTools(doc: unknown, only: string[] | undefined, source: string): LoadedTools {
  let parsed: ParseResult;
  try {
    parsed = parseOpenApiToTools(
      doc,
      only !== undefined ? { filter: { operationIds: only } } : undefined,
    );
  } catch (thrown) {
    if (thrown instanceof OpenApiParseError) {
      const pointer = thrown.pointer !== undefined ? ` (at ${thrown.pointer})` : "";
      throw new UsageError(
        `invalid OpenAPI document "${source}": ${thrown.message}${pointer}`,
      );
    }
    throw thrown;
  }

  for (const warning of parsed.warnings) {
    warn(`${warning.code}: ${warning.message}`);
  }

  if (parsed.tools.length === 0) {
    throw new UsageError(
      `no tools were generated from "${source}" — check --only / spec contents`,
    );
  }

  const byName = new Map<string, ParsedTool>();
  for (const tool of parsed.tools) {
    byName.set(tool.name, tool);
  }

  log(`serving ${parsed.tools.length} tools from ${source}`);

  return { tools: parsed.tools, byName, api: parsed.api, warnings: parsed.warnings };
}
