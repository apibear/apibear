/**
 * MCP wire projection for the apibear parser.
 *
 * The parser produces {@link import("./types.js").ParsedTool} values that also
 * carry local runner metadata. Only the `{ name, description?, inputSchema }`
 * subset may be sent to MCP clients; {@link toMcpTool} performs that projection.
 */

import type { ParsedTool } from "./types.js";

/**
 * Strip runner metadata from a parsed tool, yielding a plain MCP tool.
 *
 * The returned object contains exactly `name`, `inputSchema`, and — only when
 * the tool has one — `description`. `metadata` is never copied, and the tool
 * itself is not mutated.
 *
 * @param tool - A tool produced by {@link import("./parse.js").parseOpenApiToTools}.
 * @returns `{ name, description?, inputSchema }`, structurally compatible with
 * the `@modelcontextprotocol/sdk` `Tool` type.
 *
 * @example
 * ```ts
 * const tool = parseOpenApiToTools(doc).tools[0];
 * const wireTool = toMcpTool(tool);
 * // { name, description?, inputSchema } — no metadata key
 * ```
 */
export function toMcpTool(tool: ParsedTool): {
  name: string;
  description?: string;
  inputSchema: ParsedTool["inputSchema"];
} {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: tool.inputSchema,
  };
}
