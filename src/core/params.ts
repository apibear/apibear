/**
 * Parameter collection and merging for the apibear parser.
 *
 * All functions in this module are pure: the caller's OpenAPI objects are
 * never mutated, and every schema that leaves this module is a fresh copy.
 */

import type { ParserWarning } from "./types.js";

/**
 * A path, query, or header parameter after `$ref` resolution and merging.
 *
 * Unsupported locations (`cookie`, unknown values) are dropped during
 * collection, so `in` is narrowed to the three locations this library exposes.
 */
export interface Parameter {
  /** Parameter name as declared in the OpenAPI document. */
  name: string;
  /** Where the parameter is carried on the wire. */
  in: "path" | "query" | "header";
  /** Whether the argument is required. Path parameters are always required. */
  required: boolean;
  /** JSON Schema for the argument. Schemaless parameters become `{ type: "string" }`. */
  schema: Record<string, unknown>;
  /** Optional human-readable description, copied onto the schema by `buildInputSchema`. */
  description?: string;
}

/**
 * Result of {@link collectParameters}: the usable parameters plus any non-fatal
 * warnings emitted while merging/skipping declarations.
 */
export interface CollectResult {
  /** Supported parameters in merged declaration order. */
  parameters: Parameter[];
  /** Non-fatal problems encountered while collecting parameters. */
  warnings: ParserWarning[];
}

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
 * One merged parameter declaration, keeping its first-seen position.
 */
interface MergedParameter {
  /** Parameter name. */
  name: string;
  /** Raw `in` value; validated later so unknown locations can be warned about. */
  location: string;
  /** Resolved parameter object from the document. */
  parameter: Record<string, unknown>;
}

/**
 * Collect and merge the parameters for one operation.
 *
 * Rules:
 * 1. `pathItem.parameters` and `operation.parameters` are merged. An
 *    operation-level declaration with the same `name` + `in` overrides the
 *    path-item-level one **in place**, preserving its first-seen position.
 * 2. Every declaration is passed through `resolve`, so `$ref` parameters are
 *    flattened into plain objects.
 * 3. Only `path`, `query`, and `header` locations are supported. A `cookie`
 *    (or otherwise unknown) declaration is dropped individually and emits a
 *    `skipped-unsupported` warning naming the parameter; the operation itself
 *    is not discarded.
 * 4. Path parameters are always required, regardless of the declared
 *    `required` flag.
 * 5. A parameter without a `schema` (e.g. an OpenAPI 3.0 `content:`-style
 *    parameter) receives `{ type: "string" }`.
 * 6. Every `{name}` appearing in `pathTemplate` but not declared is
 *    synthesized as a required `{ type: "string" }` path parameter.
 *
 * Path-template synthesis runs after merging and appends synthesized
 * parameters in template order. The function never mutates `pathItem`,
 * `operation`, or anything reached through `resolve`.
 *
 * @param pathItem - The path-item object as a plain value (may be invalid).
 * @param operation - The operation object as a plain value (may be invalid).
 * @param pathTemplate - The path template, braces preserved, e.g. `/pets/{petId}`.
 * @param resolve - Deep internal-`$ref` resolver returning plain values.
 * @returns The supported parameters and any collection warnings.
 *
 * @example
 * ```ts
 * const { parameters, warnings } = collectParameters(pathItem, operation, "/pets/{petId}", resolve);
 * // parameters[0] => { name: "petId", in: "path", required: true, schema: { type: "string" } }
 * ```
 */
export function collectParameters(
  pathItem: unknown,
  operation: unknown,
  pathTemplate: string,
  resolve: SchemaResolver,
): CollectResult {
  const warnings: ParserWarning[] = [];
  const merged: MergedParameter[] = [];
  const positionByNameAndLocation = new Map<string, number>();

  /**
   * Merge one declared parameter list, preserving first-seen positions.
   */
  const addFrom = (declarations: unknown): void => {
    if (!Array.isArray(declarations)) {
      return;
    }
    for (const declaration of declarations) {
      const resolved = resolve(declaration);
      if (!isRecord(resolved)) {
        continue;
      }
      const name = typeof resolved.name === "string" ? resolved.name : "";
      const location = typeof resolved.in === "string" ? resolved.in : "";
      if (name === "" || location === "") {
        continue;
      }
      const key = `${location}\u0000${name}`;
      const existingIndex = positionByNameAndLocation.get(key);
      if (existingIndex === undefined) {
        positionByNameAndLocation.set(key, merged.length);
        merged.push({ name, location, parameter: resolved });
      } else {
        merged[existingIndex] = { name, location, parameter: resolved };
      }
    }
  };

  addFrom(isRecord(pathItem) ? pathItem.parameters : undefined);
  addFrom(isRecord(operation) ? operation.parameters : undefined);

  const parameters: Parameter[] = [];
  const declaredPathNames = new Set<string>();

  for (const candidate of merged) {
    const { name, location, parameter } = candidate;
    if (location !== "path" && location !== "query" && location !== "header") {
      warnings.push({
        code: "skipped-unsupported",
        message: `Parameter "${name}" uses unsupported location "${location}"; skipped.`,
      });
      continue;
    }

    const required = location === "path" ? true : parameter.required === true;
    const schema = isRecord(parameter.schema)
      ? cloneValue(parameter.schema)
      : { type: "string" };

    const collected: Parameter = { name, in: location, required, schema };
    if (typeof parameter.description === "string") {
      collected.description = parameter.description;
    }
    parameters.push(collected);

    if (location === "path") {
      declaredPathNames.add(name);
    }
  }

  for (const match of pathTemplate.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1];
    if (name === undefined || name === "" || declaredPathNames.has(name)) {
      continue;
    }
    declaredPathNames.add(name);
    parameters.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }

  return { parameters, warnings };
}
