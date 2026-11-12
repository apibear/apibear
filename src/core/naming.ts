/**
 * Tool-name normalization for the apibear parser.
 *
 * All functions in this module are pure. {@link dedupeName} is the only
 * exception: it records the chosen name in the caller-provided `used` set so
 * that a parse run can deduplicate names across the whole document.
 */

import type { HttpMethod } from "./types.js";

/** Maximum length of a tool name, per the MCP tool-name contract. */
const MAX_NAME_LENGTH = 64;

/**
 * Sanitize a raw operation id into a valid MCP tool name.
 *
 * Applies these rules in order:
 * 1. replace every character outside `[a-zA-Z0-9_-]` with `_`;
 * 2. collapse runs of two or more `_` into a single `_`;
 * 3. strip leading `_`;
 * 4. truncate to 64 characters.
 *
 * The result matches `/^[a-zA-Z0-9_-]{0,64}$/` (the dedupe step guarantees the
 * non-empty `{1,64}` form). Input that contains only illegal characters
 * sanitizes to the empty string; feed such a candidate to {@link dedupeName},
 * which supplies an `operation_N` fallback.
 *
 * @param input - Raw candidate id, e.g. a document `operationId` or a fallback id.
 * @returns The sanitized name, possibly empty.
 *
 * @example
 * ```ts
 * sanitizeName("pets/get by id"); // "pets_get_by_id"
 * sanitizeName("__getPets");       // "getPets"
 * ```
 */
export function sanitizeName(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9_-]/g, "_");
  const collapsed = replaced.replace(/_{2,}/g, "_");
  const stripped = collapsed.replace(/^_+/, "");
  return stripped.slice(0, MAX_NAME_LENGTH);
}

/**
 * Deduplicate a sanitized candidate against the names already used in a parse run.
 *
 * Comparison is case-insensitive: `used` holds lowercased names, and the chosen
 * name is added to it in lowercase. On collision the function appends `_2`,
 * `_3`, … until a free name is found. The base is truncated as needed so the
 * result never exceeds 64 characters.
 *
 * When `candidate` is empty, the name `operation_N` is chosen instead, where
 * `N` is the first 1-based counter whose lowercase name is unused.
 *
 * @param candidate - A name that has already passed through {@link sanitizeName}.
 * @param used - Mutated set of lowercased names already assigned in this run.
 * @returns A unique, non-empty tool name of at most 64 characters.
 *
 * @example
 * ```ts
 * const used = new Set<string>();
 * dedupeName("getPets", used); // "getPets"
 * dedupeName("getPets", used); // "getPets_2"
 * dedupeName("", used);        // "operation_1"
 * ```
 */
export function dedupeName(candidate: string, used: Set<string>): string {
  const base = candidate.slice(0, MAX_NAME_LENGTH);

  if (base.length === 0) {
    let counter = 1;
    while (used.has(`operation_${counter}`)) {
      counter += 1;
    }
    const chosen = `operation_${counter}`;
    used.add(chosen);
    return chosen;
  }

  if (!used.has(base.toLowerCase())) {
    used.add(base.toLowerCase());
    return base;
  }

  for (let suffix = 2; ; suffix += 1) {
    const tail = `_${suffix}`;
    const head = base.slice(0, MAX_NAME_LENGTH - tail.length);
    const chosen = `${head}${tail}`;
    if (!used.has(chosen.toLowerCase())) {
      used.add(chosen.toLowerCase());
      return chosen;
    }
  }
}

/**
 * Build the raw fallback operation id used when an operation has no `operationId`.
 *
 * This is the pre-sanitization id: the method joined to the path with
 * `/` replaced by `_`, and `{`/`}` stripped while keeping the inner name. The
 * result therefore still contains whatever other characters the path has; run
 * it through {@link sanitizeName} before use as a tool name.
 *
 * @param method - Lowercase HTTP method of the operation.
 * @param path - OpenAPI path template, e.g. `/pets/{petId}`.
 * @returns The raw fallback id, e.g. `get_pets_petId`.
 *
 * @example
 * ```ts
 * fallbackOperationId("get", "/pets/{petId}"); // "get_pets_petId"
 * fallbackOperationId("post", "/pets");        // "post_pets"
 * ```
 */
export function fallbackOperationId(method: HttpMethod, path: string): string {
  const withoutLeadingSlash = path.replace(/^\/+/, "");
  const normalizedPath = withoutLeadingSlash.replace(/[{}]/g, "").replace(/\//g, "_");
  return normalizedPath.length > 0 ? `${method}_${normalizedPath}` : method;
}
