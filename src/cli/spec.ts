/**
 * OpenAPI document loading.
 *
 * Loads, validates, and dereferences a document from a local path or an
 * http(s) URL. Every failure surfaces as a {@link SpecLoadError} so callers can
 * exit with code 2 and a friendly message.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";

import { SpecLoadError } from "./errors.js";

/** The document type Swagger Parser accepts and returns. */
type SpecDocument = Awaited<ReturnType<typeof SwaggerParser.parse>>;

/** Matches `http://` and `https://` sources, case-insensitively. */
const URL_PATTERN = /^https?:\/\//i;

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turn an arbitrary thrown value into a reason string for {@link SpecLoadError}.
 *
 * Swagger Parser wraps resolver failures in `ResolverError`; the underlying
 * `fetch` error code is not always preserved, but when a `code` is available
 * (e.g. `ENOENT`) it is appended so the cause is diagnosable.
 */
function describeFailure(thrown: unknown): string {
  if (thrown instanceof Error) {
    const message = thrown.message.trim() || thrown.name;
    const code = (thrown as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.length > 0 && !message.includes(code)) {
      return `${message} (${code})`;
    }
    return message;
  }
  return String(thrown);
}

/**
 * Load, validate, and dereference an OpenAPI document from a local path or
 * http(s) URL. Throws {@link SpecLoadError} on any failure.
 *
 * @param source - Local path (absolute or relative to `cwd`) or an http(s) URL.
 * @param cwd - Base directory for relative paths; defaults to `process.cwd()`.
 */
export async function loadSpec(
  source: string,
  cwd: string = process.cwd(),
): Promise<Record<string, unknown>> {
  const isUrl = URL_PATTERN.test(source);
  const target = isUrl ? source : path.resolve(cwd, source);

  if (!isUrl) {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(target);
    } catch (thrown) {
      throw new SpecLoadError(source, `file not found: ${target}`, { cause: thrown });
    }
    if (!stat.isFile()) {
      throw new SpecLoadError(source, `file not found: ${target}`);
    }
  }

  // Parse once up front: this is how Swagger 2.0 is detected *before* Swagger
  // Parser's 3.x-only validator rejects it with a generic message.
  let parsed: unknown;
  try {
    parsed = await SwaggerParser.parse(target);
  } catch (thrown) {
    throw new SpecLoadError(source, describeFailure(thrown), { cause: thrown });
  }

  if (!isPlainObject(parsed)) {
    throw new SpecLoadError(source, "spec did not parse to an object");
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "swagger")) {
    throw new SpecLoadError(source, "Swagger/OpenAPI 2.0 is not supported; use OpenAPI 3.x");
  }

  let dereferenced: unknown;
  try {
    // Validate the already-parsed object (with `target` as the base for any
    // relative external `$ref`s) instead of re-reading the source: a URL spec
    // is fetched once, not once per call. `validate` dereferences as part of
    // its work and resolves with the dereferenced document.
    //
    // `circular: "ignore"` keeps circular `$ref`s as internal `$ref`s instead of
    // building cyclic JS objects; the core parser resolves internal refs
    // itself and reports true cycles.
    dereferenced = await SwaggerParser.validate(target, parsed as SpecDocument, {
      dereference: { circular: "ignore" },
    });
  } catch (thrown) {
    throw new SpecLoadError(source, describeFailure(thrown), { cause: thrown });
  }

  if (!isPlainObject(dereferenced)) {
    throw new SpecLoadError(source, "spec did not parse to an object");
  }

  return dereferenced;
}
