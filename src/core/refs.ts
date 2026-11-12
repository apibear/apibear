/**
 * Internal `$ref` resolution for the apibear parser.
 *
 * The parser only resolves refs that point inside the same document
 * (`#/components/...`). External refs (`https://…`, `file://…`, other
 * documents) are never fetched or followed: they are treated as opaque and
 * either reported through {@link tryResolveRef} / {@link containsExternalRef}
 * or left in place by {@link resolveDeep}. Dereferencing external refs is the
 * caller's job (the CLI does it with `@apidevtools/swagger-parser`).
 *
 * Every function in this module is pure: inputs are never mutated, and
 * {@link resolveDeep} always builds new objects and arrays for the value it
 * returns. No Node-only APIs are used.
 */

import { OpenApiParseError } from "./types.js";

/** Maximum number of `$ref` expansions allowed along one resolution path. */
const MAX_REF_DEPTH = 32;

/**
 * Classification of a `$ref` string by target location.
 *
 * - `"internal"`: the ref points inside the current document (`"#"` or `"#/…"`).
 * - `"external"`: anything else (URLs, file paths, other documents, relative refs).
 */
export type RefClassification = "internal" | "external";

/**
 * Discriminated outcome of {@link tryResolveRef}.
 *
 * - `resolved`: the pointer was found; `value` is the raw target (not deep-resolved).
 * - `external`: the ref does not point inside this document and was not followed.
 * - `unresolved`: the ref is internal but the JSON pointer does not exist.
 */
export type RefResolution =
  | { kind: "resolved"; value: unknown }
  | { kind: "external"; ref: string }
  | { kind: "unresolved"; ref: string };

/**
 * Determine whether a `$ref` string targets the current document.
 *
 * A ref is internal if and only if it equals `"#"` or starts with `"#/"`, per
 * the JSON-pointer URI-fragment form used by OpenAPI documents. Everything
 * else — absolute URLs, `file://` paths, relative document refs — is external.
 *
 * @param ref - The raw `$ref` string.
 * @returns `"internal"` for `"#"` / `"#/…"`, otherwise `"external"`.
 *
 * @example
 * ```ts
 * classifyRef("#/components/schemas/Pet"); // "internal"
 * classifyRef("#");                        // "internal"
 * classifyRef("https://example.com/a.json#/Pet"); // "external"
 * ```
 */
export function classifyRef(ref: string): RefClassification {
  return ref === "#" || ref.startsWith("#/") ? "internal" : "external";
}

/**
 * Decode a single JSON-pointer token.
 *
 * Applies RFC 6901 / RFC 3986 decoding in order: percent-escapes are decoded
 * with {@link decodeURIComponent} (so `%20` → a space and `%7E1` → `~1`), then
 * `~1` becomes `/` and finally `~0` becomes `~`. The `~1` substitution must run
 * before `~0` so that `~01` decodes to the literal `~1` rather than `/`.
 *
 * Malformed percent-escapes are left undecoded rather than throwing; the
 * resulting token then normally fails to match, surfacing as an
 * `unresolvable-ref` error.
 *
 * @param token - One raw pointer segment (already split on `/`).
 * @returns The decoded property name or array index.
 */
function decodePointerToken(token: string): string {
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    // Malformed escape sequence: use the raw token; lookup will fail if unknown.
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** A found/failed JSON-pointer lookup result. */
type PointerLookup = { found: true; value: unknown } | { found: false };

/**
 * Look up a decoded JSON pointer in a document without copying anything.
 *
 * @param doc - Root value the pointer is evaluated against.
 * @param ref - An internal ref (`"#"` or `"#/…"`).
 * @returns The target value when every token exists, otherwise `{ found: false }`.
 */
function resolvePointer(doc: unknown, ref: string): PointerLookup {
  if (ref === "#") {
    return { found: true, value: doc };
  }

  // `tryResolveRef` only calls this for internal refs, so the prefix is `#/`.
  const tokens = ref.slice(2).split("/").map(decodePointerToken);
  let current: unknown = doc;

  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
        return { found: false };
      }
      const index = Number(token);
      if (index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, token)) {
      return { found: false };
    }
    current = current[token];
  }

  return { found: true, value: current };
}

/**
 * Resolve an internal `$ref` one hop, reporting the outcome instead of throwing.
 *
 * Unlike {@link resolveInternalRef}, this never throws for an external or
 * missing pointer — callers that need graceful degradation use the
 * discriminated result. It does not deep-resolve the target; feed the returned
 * value to {@link resolveDeep} for that.
 *
 * @param doc - The OpenAPI document as a plain object.
 * @param ref - The raw `$ref` string.
 * @returns A discriminated result: `resolved`, `external`, or `unresolved`.
 */
export function tryResolveRef(doc: unknown, ref: string): RefResolution {
  if (classifyRef(ref) === "external") {
    return { kind: "external", ref };
  }

  const pointer = resolvePointer(doc, ref);
  if (!pointer.found) {
    return { kind: "unresolved", ref };
  }
  return { kind: "resolved", value: pointer.value };
}

/**
 * Resolve an internal `$ref` to its raw target value.
 *
 * The lookup is a single hop: if the target is itself a `{ $ref }` object, that
 * object is returned and {@link resolveDeep} should be used to follow the rest
 * of the chain. External refs are not followed (and not an error): the ref
 * string is returned unchanged so the caller can decide what to do. Use
 * {@link tryResolveRef} when the distinction matters.
 *
 * @param doc - The OpenAPI document as a plain object.
 * @param ref - The raw `$ref` string, e.g. `#/components/schemas/Pet`.
 * @returns The target value, or the ref string itself for an external ref.
 * @throws {OpenApiParseError} `unresolvable-ref` when the pointer does not exist.
 *
 * @example
 * ```ts
 * const doc = { components: { schemas: { Pet: { type: "object" } } } };
 * resolveInternalRef(doc, "#/components/schemas/Pet"); // { type: "object" }
 * ```
 */
export function resolveInternalRef(doc: unknown, ref: string): unknown {
  const result = tryResolveRef(doc, ref);
  switch (result.kind) {
    case "resolved":
      return result.value;
    case "external":
      // External refs are somebody else's job; return the ref untouched.
      return result.ref;
    case "unresolved":
      throw new OpenApiParseError(
        "unresolvable-ref",
        `Unable to resolve internal $ref "${ref}": the JSON pointer does not exist in the document.`,
        ref,
      );
  }
}

/**
 * Deeply resolve internal `$ref`s in a value, returning a fresh copy.
 *
 * Walks objects and arrays and replaces every `{ "$ref": "…" }` object whose
 * target is internal with the deeply resolved target. Sibling keys of a
 * `$ref` object are ignored (JSON Reference semantics). Chains are followed
 * until a concrete value is reached.
 *
 * External refs are left in place (`{ $ref: "https://…" }` survives verbatim in
 * structure); use {@link containsExternalRef} to detect them afterwards.
 *
 * The input `doc` and `value` are never mutated; every container in the result
 * is newly allocated.
 *
 * @param doc - The OpenAPI document that `ref` pointers are evaluated against.
 * @param value - The value to copy and resolve (a schema, parameter, …).
 * @returns A deep copy of `value` with internal refs expanded.
 * @throws {OpenApiParseError} `ref-cycle` when a ref is revisited on the current
 * resolution stack or the chain exceeds 32 expansions.
 * @throws {OpenApiParseError} `unresolvable-ref` when an internal ref cannot be found.
 *
 * @example
 * ```ts
 * const doc = {
 *   components: { schemas: { Pet: { type: "object", properties: { name: { type: "string" } } } } },
 * };
 * resolveDeep(doc, { $ref: "#/components/schemas/Pet" });
 * // { type: "object", properties: { name: { type: "string" } } }
 * ```
 */
export function resolveDeep(doc: unknown, value: unknown): unknown {
  return resolveValue(doc, value, { stack: [], depth: 0 });
}

/** Immutable state carried while resolving one value. */
interface ResolutionState {
  /** Internal refs currently being expanded, outermost first. */
  readonly stack: readonly string[];
  /** Number of `$ref` expansions on the current path. */
  readonly depth: number;
}

/**
 * Recursively copy `value`, expanding internal refs.
 *
 * @param doc - Document used for pointer lookups.
 * @param value - Current value being copied.
 * @param state - Current ref stack and expansion depth.
 * @returns A freshly allocated copy with internal refs expanded.
 */
function resolveValue(doc: unknown, value: unknown, state: ResolutionState): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(doc, item, state));
  }

  if (!isRecord(value)) {
    return value;
  }

  const ref = value["$ref"];
  if (typeof ref === "string") {
    return resolveRefObject(doc, value, ref, state);
  }

  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = resolveValue(doc, value[key], state);
  }
  return copy;
}

/**
 * Expand one `{ $ref }` object, guarding against cycles and runaway chains.
 *
 * @param doc - Document used for pointer lookups.
 * @param object - The ref object (used only to copy its keys when external).
 * @param ref - The `$ref` string.
 * @param state - Current ref stack and expansion depth.
 * @returns The resolved target (for internal refs) or a copy of the object (external).
 */
function resolveRefObject(
  doc: unknown,
  object: Record<string, unknown>,
  ref: string,
  state: ResolutionState,
): unknown {
  if (classifyRef(ref) === "external") {
    // Leave external refs structurally as they are, but still deep-copy them.
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      copy[key] = resolveValue(doc, object[key], state);
    }
    return copy;
  }

  if (state.stack.includes(ref)) {
    throw new OpenApiParseError(
      "ref-cycle",
      `Circular $ref detected: "${ref}" is already being resolved.`,
      ref,
    );
  }

  const depth = state.depth + 1;
  if (depth > MAX_REF_DEPTH) {
    throw new OpenApiParseError(
      "ref-cycle",
      `Maximum $ref resolution depth of ${MAX_REF_DEPTH} exceeded while resolving "${ref}".`,
      ref,
    );
  }

  const pointer = resolvePointer(doc, ref);
  if (!pointer.found) {
    throw new OpenApiParseError(
      "unresolvable-ref",
      `Unable to resolve internal $ref "${ref}": the JSON pointer does not exist in the document.`,
      ref,
    );
  }

  const nextStack = [...state.stack, ref];
  return resolveValue(doc, pointer.value, { stack: nextStack, depth });
}

/**
 * Find the first external `$ref` string anywhere inside a value.
 *
 * Scans objects and arrays without following refs, so it is meant to be called
 * on the output of {@link resolveDeep}. Cyclic plain-object graphs are handled
 * safely. Returns `null` when every `$ref` found is internal (or none exist).
 *
 * @param value - Any value, typically a resolved schema or operation fragment.
 * @returns The first external `$ref` string in depth-first order, or `null`.
 *
 * @example
 * ```ts
 * containsExternalRef({ items: { $ref: "https://example.com/Pet.json" } });
 * // "https://example.com/Pet.json"
 * containsExternalRef({ $ref: "#/components/schemas/Pet" }); // null
 * ```
 */
export function containsExternalRef(value: unknown): string | null {
  return scanExternalRef(value, new WeakSet<object>());
}

/**
 * Recursive worker for {@link containsExternalRef}.
 *
 * @param value - Current value being scanned.
 * @param seen - Containers already visited, preventing infinite descent on cycles.
 * @returns The first external ref string found, or `null`.
 */
function scanExternalRef(value: unknown, seen: WeakSet<object>): string | null {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);
    for (const item of value) {
      const found = scanExternalRef(item, seen);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  const ref = value["$ref"];
  if (typeof ref === "string" && classifyRef(ref) === "external") {
    return ref;
  }

  for (const key of Object.keys(value)) {
    const found = scanExternalRef(value[key], seen);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * Narrow a value to a plain (non-array, non-null) object record.
 *
 * @param value - Value to test.
 * @returns `true` when `value` is a plain object suitable for key access.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
