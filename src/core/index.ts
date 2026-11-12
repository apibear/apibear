/**
 * Public entry point for the apibear parser.
 *
 * Only the public contract is exported here: the concrete parser and MCP
 * projection implementations, the typed error, and the public types. Helper
 * modules (`naming`, `refs`, `params`, `schema`, `servers`) stay internal.
 */

/** Convert an OpenAPI 3.0/3.1 document into tools plus runner metadata. */
export { parseOpenApiToTools } from "./parse.js";

/** Project a parsed tool onto the `{ name, description?, inputSchema }` wire shape. */
export { toMcpTool } from "./mcp.js";

/** Typed error thrown when a document cannot be parsed or a critical `$ref` fails. */
export { OpenApiParseError } from "./types.js";

/** Public data contract: tools, metadata, options, warnings, and results. */
export type {
  HttpMethod,
  OperationMetadata,
  ParameterLocation,
  ParseResult,
  ParsedTool,
  ParserOptions,
  ParserWarning,
  RequestBodyPlan,
} from "./types.js";
