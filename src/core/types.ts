/**
 * Public data contract for the apibear parser.
 *
 * These types are the package's public API (re-exported from `apibear`) and
 * are also what the CLI consumes. Changing them is a breaking change.
 */

/**
 * HTTP methods supported by the parser.
 *
 * Operations are discovered in this order: `get`, `post`, `put`, `patch`,
 * `delete`, `head`, `options`, `trace`.
 */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options" | "trace";

/**
 * Execution plan consumed by `apibear`. Never serialized to MCP clients.
 */
export interface OperationMetadata {
  /** Raw `operationId`, or the generated fallback (pre-sanitization). */
  operationId: string;
  /** HTTP method of the operation. */
  method: HttpMethod;
  /** Path template, e.g. `/pets/{petId}` — braces are preserved. */
  pathTemplate: string;
  /** Base URL resolved from `servers` (variables substituted); `null` => caller must supply one. */
  baseUrl: string | null;
  /** Path/query/header parameters exposed in `inputSchema`. */
  parameters: ParameterLocation[];
  /** Request body plan, or `null` when the operation has no request body. */
  requestBody: RequestBodyPlan | null;
  /** Header param names that duplicate an apiKey-in-header security scheme; excluded from `inputSchema`, NOT auto-injected. */
  securityHeaderNames: string[];
  /** Whether the operation was marked `deprecated: true`. */
  deprecated: boolean;
}

/**
 * Location of a parameter exposed as a top-level `inputSchema` property.
 */
export interface ParameterLocation {
  /** Parameter name as it appears in the OpenAPI document. */
  name: string;
  /** Where the parameter is carried on the wire. */
  in: "path" | "query" | "header";
  /** Whether the argument is required. Path parameters are always required. */
  required: boolean;
}

/**
 * Plan describing how a request body maps onto `inputSchema`.
 */
export interface RequestBodyPlan {
  /** Whether the OpenAPI request body itself is required. */
  required: boolean;
  /** Chosen content type. */
  contentType: string;
  /** `"merged"`: body properties are top-level keys of `inputSchema`; `"nested"`: whole body lives under `bodyKey`. */
  embedding: "merged" | "nested";
  /** Present iff `embedding === "nested"` (always `"body"`). */
  bodyKey?: string;
}

/**
 * A single MCP tool produced from an OpenAPI operation.
 */
export interface ParsedTool {
  /** Sanitized + deduped name, matching `/^[a-zA-Z0-9_-]{1,64}$/`. */
  name: string;
  /** Optional human-readable description. */
  description?: string;
  /** JSON-Schema object describing the tool arguments. */
  inputSchema: {
    /** Always an object schema. */
    type: "object";
    /** Argument name -> JSON Schema for that argument. */
    properties: Record<string, Record<string, unknown>>;
    /** Names of required arguments. */
    required: string[];
    /** Always `false`: unknown arguments are rejected. */
    additionalProperties: false;
  };
  /** Local runner metadata; must never reach the wire. */
  metadata: OperationMetadata;
}

/**
 * Non-fatal problem encountered while parsing a document.
 */
export interface ParserWarning {
  /** Machine-readable warning category. */
  code: "unknown-filter-id" | "unresolved-ref" | "skipped-unsupported" | "no-server-url" | "relative-server-url";
  /** Human-readable explanation. */
  message: string;
  /** JSON pointer to the offending location, when known. */
  pointer?: string;
}

/**
 * Result of parsing an OpenAPI document.
 */
export interface ParseResult {
  /** Tools produced from the document, in discovery order. */
  tools: ParsedTool[];
  /** Document-level summary. */
  api: { title: string; version: string; baseUrl: string | null };
  /** Non-fatal problems encountered during parsing. */
  warnings: ParserWarning[];
}

/**
 * Options controlling which operations become tools.
 */
export interface ParserOptions {
  /** Filter object; only tools whose ORIGINAL operationId (or generated fallback id) matches are returned. */
  filter?: {
    /** Allowed original operation ids (pre-sanitization). */
    operationIds?: string[];
    /** Allowed methods. Default: get, post, put, patch, delete. */
    methods?: HttpMethod[];
    /** Whether deprecated operations are included. Default: `false`. */
    includeDeprecated?: boolean;
  };
}

/**
 * Convert an OpenAPI 3.0/3.1 document into MCP tools plus execution metadata.
 *
 * Accepts a plain JS object (dereferenced or containing internal `$ref`s) and
 * never mutates it. External refs are not resolved here; the caller should
 * dereference them first (e.g. with `@apidevtools/swagger-parser`).
 *
 * @param doc - The OpenAPI document as a plain object.
 * @param options - Optional filtering/behavior options.
 * @returns The parsed tools, document summary, and non-fatal warnings.
 * @throws {OpenApiParseError} When the document is invalid or a critical `$ref` cannot be resolved.
 *
 * @remarks The implementation lives in `./parse.js`; this declaration is the
 * frozen public contract that it must satisfy. It is intentionally NOT
 * re-exported from `./index.js` — export the concrete implementation instead.
 */
export declare function parseOpenApiToTools(doc: unknown, options?: ParserOptions): ParseResult;

/**
 * Strip `metadata` so the object is a plain MCP Tool (superset-safe projection).
 *
 * @param tool - A tool produced by {@link parseOpenApiToTools}.
 * @returns `{ name, description?, inputSchema }`, structurally compatible with the MCP SDK `Tool` type.
 *
 * @remarks The implementation lives in `./mcp.js`; this declaration is the
 * frozen public contract that it must satisfy. It is intentionally NOT
 * re-exported from `./index.js` — export the concrete implementation instead.
 */
export declare function toMcpTool(tool: ParsedTool): {
  name: string;
  description?: string;
  inputSchema: ParsedTool["inputSchema"];
};

/**
 * Error thrown when an OpenAPI document cannot be parsed.
 *
 * @example
 * ```ts
 * try {
 *   parseOpenApiToTools(doc);
 * } catch (error) {
 *   if (error instanceof OpenApiParseError && error.code === "invalid-document") {
 *     // handle malformed input
 *   }
 * }
 * ```
 */
export class OpenApiParseError extends Error {
  /** Machine-readable failure category. */
  readonly code: "invalid-document" | "unresolvable-ref" | "ref-cycle";
  /** JSON pointer to the offending location in the document, when known. */
  readonly pointer?: string;

  /**
   * Create a parse error.
   *
   * @param code - Machine-readable failure category.
   * @param message - Human-readable explanation.
   * @param pointer - Optional JSON pointer to the offending document location.
   */
  constructor(code: OpenApiParseError["code"], message: string, pointer?: string) {
    super(message);
    this.name = "OpenApiParseError";
    this.code = code;
    if (pointer !== undefined) {
      this.pointer = pointer;
    }
  }
}
