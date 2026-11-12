/**
 * `inputSchema` construction for the apibear parser.
 *
 * All exported functions are pure: parameters, request bodies, and every
 * schema reached through the resolver are copied before being folded into the
 * result. The caller's OpenAPI objects are never mutated.
 */

import type { Parameter } from "./params.js";
import type { ParameterLocation, ParsedTool, RequestBodyPlan } from "./types.js";

/**
 * Resolve a value through the caller-provided internal-`$ref` resolver.
 *
 * The resolver is expected to deep-resolve internal `$ref`s and return a plain
 * value. This library never imports the `$ref` resolver directly so that the
 * parameter/schema modules stay independent of the reference implementation.
 */
type SchemaResolver = (value: unknown) => unknown;

/**
 * Narrow an unknown value to a plain (non-array) object.
 *
 * @param value - Value to inspect.
 * @returns `true` when `value` is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-copy a JSON-like value so transformed output never aliases caller data.
 *
 * @param value - Value to copy.
 * @returns A structural copy of `value`.
 */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = cloneValue(item);
    }
    return copy as T;
  }
  return value;
}

/**
 * Build the frozen root-schema shape from properties and required names.
 *
 * @param properties - Argument name -> JSON Schema.
 * @param required - Required argument names, already deduplicated.
 * @returns A complete `inputSchema` object.
 */
function buildRoot(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): ParsedTool["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * Pick a content type from the declared keys, honoring the content-type priority.
 *
 * Exact matches win; a match ignoring media-type parameters (e.g.
 * `application/json; charset=utf-8`) is accepted as a fallback. The first
 * listed type is returned when neither JSON nor form encoding is available.
 *
 * @param contentTypes - Content-map keys in document order.
 * @returns The selected content type (always one of `contentTypes`).
 */
function chooseContentType(contentTypes: string[]): string {
  const preferred = ["application/json", "application/x-www-form-urlencoded"];
  for (const mediaType of preferred) {
    const exact = contentTypes.find((candidate) => candidate === mediaType);
    if (exact !== undefined) {
      return exact;
    }
    const normalized = contentTypes.find(
      (candidate) => candidate.split(";")[0]?.trim().toLowerCase() === mediaType,
    );
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return contentTypes[0] ?? "application/json";
}

/**
 * Project collected parameters onto the public `metadata.parameters` shape.
 *
 * Path parameters are always reported as required, matching
 * {@link buildInputSchema}.
 *
 * @param params - Parameters produced by `collectParameters`.
 * @returns One `{ name, in, required }` entry per parameter, in order.
 *
 * @example
 * ```ts
 * schemaForParameterLocations([
 *   { name: "petId", in: "path", required: false, schema: { type: "string" } },
 * ]); // [{ name: "petId", in: "path", required: true }]
 * ```
 */
export function schemaForParameterLocations(params: Parameter[]): ParameterLocation[] {
  return params.map((parameter) => ({
    name: parameter.name,
    in: parameter.in,
    required: parameter.in === "path" ? true : parameter.required,
  }));
}

/**
 * Build an MCP `inputSchema` plus the matching request-body execution plan.
 *
 * Rules:
 * - The root is `{ type: "object", properties, required, additionalProperties: false }`.
 * - Each parameter contributes its schema verbatim; the parameter's
 *   `description` is copied onto the property only when the schema lacks one.
 * - Required names are deduplicated; path parameters are always required.
 * - The request body (resolved through `resolve`, which also handles a
 *   `$ref`-ed request-body object) selects `application/json`, then
 *   `application/x-www-form-urlencoded`, then the first listed content type.
 * - An object body with a `properties` map and no name collision with a
 *   parameter is **merged** into the root; otherwise the whole body schema is
 *   placed under the `body` property (**nested**), which becomes required iff
 *   the request body itself is required.
 * - A body with no content (or no `requestBody`) yields `requestBodyPlan: null`.
 *
 * Empty inputs produce `{ type: "object", properties: {}, required: [], additionalProperties: false }`.
 * The function never mutates `params`, `requestBody`, or resolved schemas.
 *
 * @param params - Supported parameters from `collectParameters`.
 * @param requestBody - The operation's `requestBody` value, possibly `$ref`-ed or absent.
 * @param resolve - Deep internal-`$ref` resolver returning plain values.
 * @returns The root JSON Schema and the request-body plan (or `null`).
 *
 * @example
 * ```ts
 * const { inputSchema, requestBodyPlan } = buildInputSchema(parameters, operation.requestBody, resolve);
 * // requestBodyPlan?.embedding === "merged" | "nested"
 * ```
 */
export function buildInputSchema(
  params: Parameter[],
  requestBody: unknown,
  resolve: SchemaResolver,
): { inputSchema: ParsedTool["inputSchema"]; requestBodyPlan: RequestBodyPlan | null } {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const requiredNames = new Set<string>();

  /**
   * Append a required argument name exactly once.
   */
  const addRequired = (name: string): void => {
    if (!requiredNames.has(name)) {
      requiredNames.add(name);
      required.push(name);
    }
  };

  for (const parameter of params) {
    const schema = cloneValue(parameter.schema);
    if (typeof schema.description !== "string" && typeof parameter.description === "string") {
      schema.description = parameter.description;
    }
    properties[parameter.name] = schema;
    if (parameter.in === "path" || parameter.required) {
      addRequired(parameter.name);
    }
  }

  if (requestBody === null || requestBody === undefined) {
    return { inputSchema: buildRoot(properties, required), requestBodyPlan: null };
  }

  const resolvedRequestBody = resolve(requestBody);
  if (!isRecord(resolvedRequestBody) || !isRecord(resolvedRequestBody.content)) {
    return { inputSchema: buildRoot(properties, required), requestBodyPlan: null };
  }

  const contentTypes = Object.keys(resolvedRequestBody.content);
  if (contentTypes.length === 0) {
    return { inputSchema: buildRoot(properties, required), requestBodyPlan: null };
  }

  const contentType = chooseContentType(contentTypes);
  const media = resolvedRequestBody.content[contentType];
  const rawBodySchema = isRecord(media) ? media.schema : undefined;
  const resolvedBodySchema = rawBodySchema === undefined ? undefined : resolve(rawBodySchema);
  const bodySchema: Record<string, unknown> = isRecord(resolvedBodySchema)
    ? cloneValue(resolvedBodySchema)
    : {};
  const bodyRequired = resolvedRequestBody.required === true;

  const bodyProperties = bodySchema.properties;
  const hasMergedShape = bodySchema.type === "object" && isRecord(bodyProperties);
  const collides =
    isRecord(bodyProperties) &&
    Object.keys(bodyProperties).some((name) => Object.prototype.hasOwnProperty.call(properties, name));

  if (hasMergedShape && !collides && isRecord(bodyProperties)) {
    for (const [name, schema] of Object.entries(bodyProperties)) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) {
        properties[name] = isRecord(schema) ? cloneValue(schema) : {};
      }
    }
    if (Array.isArray(bodySchema.required)) {
      for (const name of bodySchema.required) {
        if (typeof name === "string") {
          addRequired(name);
        }
      }
    }
    return {
      inputSchema: buildRoot(properties, required),
      requestBodyPlan: { required: bodyRequired, contentType, embedding: "merged" },
    };
  }

  properties.body = bodySchema;
  if (bodyRequired) {
    addRequired("body");
  }
  return {
    inputSchema: buildRoot(properties, required),
    requestBodyPlan: { required: bodyRequired, contentType, embedding: "nested", bodyKey: "body" },
  };
}
