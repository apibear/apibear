/**
 * Main entry point for the apibear parser.
 *
 * {@link parseOpenApiToTools} walks the document's paths in insertion order,
 * discovers operations in a fixed method order, and composes the naming,
 * parameter, schema, ref-resolution, and server modules into tools plus local
 * runner metadata.
 *
 * The parser is pure: the caller's document is only ever read, never mutated.
 * It performs no I/O and uses no Node-only APIs.
 */

import { dedupeName, fallbackOperationId, sanitizeName } from "./naming.js";
import { collectParameters } from "./params.js";
import { containsExternalRef, resolveDeep } from "./refs.js";
import { buildInputSchema, schemaForParameterLocations } from "./schema.js";
import { pickServer, resolveBaseUrl } from "./servers.js";
import {
  OpenApiParseError,
  type HttpMethod,
  type OperationMetadata,
  type ParsedTool,
  type ParserOptions,
  type ParserWarning,
  type ParseResult,
} from "./types.js";

/** Methods are discovered in this fixed order. */
const METHOD_ORDER: readonly HttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
];

/** Methods enabled when `filter.methods` is not supplied. */
const DEFAULT_METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"];

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
 * Escape one JSON-pointer reference token per RFC 6901.
 *
 * @param token - Object key, e.g. a path template containing `/`.
 * @returns The escaped token ( `/` → `~1`, `~` → `~0`).
 */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Internal signal raised when a resolved critical-path value still contains an
 * external `$ref`. External refs are the caller's responsibility, so the
 * affected operation is skipped with an `unresolved-ref` warning.
 */
class ExternalRefSignal {
  /** The external `$ref` string that was found. */
  readonly ref: string;

  /**
   * Create the signal.
   *
   * @param ref - External `$ref` string that cannot be resolved here.
   */
  constructor(ref: string) {
    this.ref = ref;
  }
}

/**
 * Read the non-empty `operationId` of an operation, if any.
 *
 * @param operation - Operation object as a plain value.
 * @returns The raw operation id, or `undefined` when absent/empty.
 */
function readOperationId(operation: Record<string, unknown>): string | undefined {
  const value = operation.operationId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read the human-readable description for an operation.
 *
 * `summary` wins over `description`. Empty
 * strings are treated as absent so a blank summary does not hide a useful
 * description.
 *
 * @param operation - Operation object as a plain value.
 * @returns The chosen description, or `undefined` when neither field is usable.
 */
function readDescription(operation: Record<string, unknown>): string | undefined {
  const summary = operation.summary;
  if (typeof summary === "string" && summary.length > 0) {
    return summary;
  }
  const description = operation.description;
  if (typeof description === "string" && description.length > 0) {
    return description;
  }
  return undefined;
}

/**
 * Throw an `invalid-document` parse error.
 *
 * @param reason - Human-readable explanation for the failure.
 * @throws {OpenApiParseError} Always, with `code: "invalid-document"`.
 */
function invalidDocument(reason: string): never {
  throw new OpenApiParseError("invalid-document", reason);
}

/**
 * Build the key used to collapse duplicate server warnings.
 *
 * @param warning - Warning to key.
 * @returns A stable `code + message` string.
 */
function serverWarningKey(warning: ParserWarning): string {
  return `${warning.code}\u0000${warning.message}`;
}

/**
 * Convert an OpenAPI 3.0/3.1 document into MCP tools plus execution metadata.
 *
 * Composition rules:
 * - Paths are visited in insertion order; methods in the fixed order
 *   `get, post, put, patch, delete, head, options, trace`.
 * - The default method set is `get, post, put, patch, delete`; disabled method
 *   types emit one aggregated `skipped-unsupported` warning each.
 * - `deprecated: true` operations are skipped unless
 *   `filter.includeDeprecated`; included ones get `" (deprecated)"` appended to
 *   their description.
 * - Tool names come from the raw `operationId`, else from the generated
 *   fallback id, then pass through `sanitizeName` + global `dedupeName`.
 * - Parameters and request bodies are deep-resolved (internal `$ref`s only).
 *   An operation touching an external or unresolvable internal ref is skipped
 *   with an `unresolved-ref` warning; a `$ref` cycle propagates as an
 *   `OpenApiParseError` (`ref-cycle`).
 * - `api.baseUrl` is the root server resolution; a `no-server-url` warning is
 *   emitted once at the document level rather than per operation.
 * - `filter.operationIds` matches the original id or the generated fallback id;
 *   ids that match nothing emit `unknown-filter-id` warnings and never throw.
 *
 * The document is validated as a non-null object carrying an `openapi` or
 * `swagger` string. Missing/empty `paths` yields an empty result with no
 * warnings. The input is never mutated.
 *
 * @param doc - The OpenAPI document as a plain object.
 * @param options - Optional filtering/behavior options.
 * @returns The tools in discovery order, the API summary, and non-fatal warnings.
 * @throws {OpenApiParseError} `invalid-document` for malformed input, or
 * `ref-cycle` when critical-path `$ref` resolution loops.
 *
 * @example
 * ```ts
 * const { tools, api, warnings } = parseOpenApiToTools(document);
 * tools.map((tool) => tool.name); // ["listPets", "createPet", "showPetById"]
 * ```
 */
export function parseOpenApiToTools(doc: unknown, options: ParserOptions = {}): ParseResult {
  if (!isRecord(doc)) {
    invalidDocument("The OpenAPI document must be a non-null object.");
  }
  if (typeof doc.openapi !== "string" && typeof doc.swagger !== "string") {
    invalidDocument('The document must declare an "openapi" or "swagger" version string.');
  }
  if (doc.paths !== undefined && doc.paths !== null && !isRecord(doc.paths)) {
    invalidDocument('The document "paths" field must be an object when present.');
  }

  const info = isRecord(doc.info) ? doc.info : {};
  const rootResolution = resolveBaseUrl(pickServer(undefined, undefined, doc));
  const api = {
    title: typeof info.title === "string" ? info.title : "",
    version: typeof info.version === "string" ? info.version : "",
    baseUrl: rootResolution.baseUrl,
  };

  const pathEntries = isRecord(doc.paths) ? Object.entries(doc.paths) : [];
  if (pathEntries.length === 0) {
    return { tools: [], api, warnings: [] };
  }

  const filter = options.filter ?? {};
  const filterIds = Array.isArray(filter.operationIds)
    ? new Set(filter.operationIds.filter((id): id is string => typeof id === "string"))
    : undefined;
  const allowedMethods = new Set<HttpMethod>(
    Array.isArray(filter.methods) ? filter.methods : DEFAULT_METHODS,
  );
  const includeDeprecated = filter.includeDeprecated === true;

  const tools: ParsedTool[] = [];
  const warnings: ParserWarning[] = [];
  const serverWarningKeys = new Set<string>();
  const usedNames = new Set<string>();
  const knownOperationIds = new Set<string>();
  const skippedMethodCounts = new Map<HttpMethod, number>();

  /**
   * Append a server warning unless an identical one was already recorded.
   *
   * @param warning - Server-resolution warning to record.
   */
  const addServerWarning = (warning: ParserWarning): void => {
    const key = serverWarningKey(warning);
    if (serverWarningKeys.has(key)) {
      return;
    }
    serverWarningKeys.add(key);
    warnings.push(warning);
  };

  if (rootResolution.warning !== undefined) {
    addServerWarning(rootResolution.warning);
  }

  for (const [pathTemplate, pathItem] of pathEntries) {
    if (!isRecord(pathItem)) {
      continue;
    }

    for (const method of METHOD_ORDER) {
      const operation = pathItem[method];
      if (!isRecord(operation)) {
        continue;
      }

      const rawOperationId = readOperationId(operation);
      const fallbackId = fallbackOperationId(method, pathTemplate);
      const originalId = rawOperationId ?? fallbackId;
      knownOperationIds.add(originalId);
      knownOperationIds.add(fallbackId);

      if (!allowedMethods.has(method)) {
        skippedMethodCounts.set(method, (skippedMethodCounts.get(method) ?? 0) + 1);
        continue;
      }

      if (
        filterIds !== undefined &&
        !filterIds.has(originalId) &&
        !filterIds.has(fallbackId)
      ) {
        continue;
      }

      const deprecated = operation.deprecated === true;
      if (deprecated && !includeDeprecated) {
        continue;
      }

      const operationPointer = `#/paths/${escapePointerToken(pathTemplate)}/${method}`;
      const baseUrlResolution = resolveBaseUrl(pickServer(operation, pathItem, doc));

      /**
       * Deep-resolve internal refs on this operation's critical path.
       *
       * @param value - Raw parameter/request-body fragment.
       * @returns The resolved copy.
       * @throws {ExternalRefSignal} When an external ref remains in the result.
       */
      const resolve = (value: unknown): unknown => {
        const resolved = resolveDeep(doc, value);
        const external = containsExternalRef(resolved);
        if (external !== null) {
          throw new ExternalRefSignal(external);
        }
        return resolved;
      };

      try {
        const collected = collectParameters(pathItem, operation, pathTemplate, resolve);
        const built = buildInputSchema(collected.parameters, operation.requestBody, resolve);

        let description = readDescription(operation);
        if (deprecated && description !== undefined) {
          description = `${description} (deprecated)`;
        }

        const name = dedupeName(sanitizeName(originalId), usedNames);
        const metadata: OperationMetadata = {
          operationId: originalId,
          method,
          pathTemplate,
          baseUrl: baseUrlResolution.baseUrl,
          parameters: schemaForParameterLocations(collected.parameters),
          requestBody: built.requestBodyPlan,
          securityHeaderNames: [],
          deprecated,
        };

        const tool: ParsedTool = {
          name,
          inputSchema: built.inputSchema,
          metadata,
        };
        if (description !== undefined) {
          tool.description = description;
        }
        tools.push(tool);

        for (const warning of collected.warnings) {
          warnings.push(warning);
        }
        if (
          baseUrlResolution.warning !== undefined &&
          baseUrlResolution.warning.code !== "no-server-url"
        ) {
          addServerWarning(baseUrlResolution.warning);
        }
      } catch (error) {
        if (error instanceof ExternalRefSignal) {
          warnings.push({
            code: "unresolved-ref",
            message: `Operation "${method.toUpperCase()} ${pathTemplate}" was skipped: external $ref "${error.ref}" cannot be resolved.`,
            pointer: operationPointer,
          });
          continue;
        }
        if (error instanceof OpenApiParseError && error.code === "unresolvable-ref") {
          warnings.push({
            code: "unresolved-ref",
            message: `Operation "${method.toUpperCase()} ${pathTemplate}" was skipped: ${error.message}`,
            pointer: error.pointer ?? operationPointer,
          });
          continue;
        }
        throw error;
      }
    }
  }

  for (const method of METHOD_ORDER) {
    const count = skippedMethodCounts.get(method);
    if (count === undefined || count === 0) {
      continue;
    }
    warnings.push({
      code: "skipped-unsupported",
      message: `HTTP method "${method}" is not enabled; ${count} operation(s) skipped.`,
    });
  }

  if (filterIds !== undefined) {
    for (const id of filterIds) {
      if (!knownOperationIds.has(id)) {
        warnings.push({
          code: "unknown-filter-id",
          message: `Unknown filter operationId "${id}"; it does not match any operation in the document.`,
        });
      }
    }
  }

  return { tools, api, warnings };
}
