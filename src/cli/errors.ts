/**
 * Error types shared by the CLI modules.
 *
 * `UsageError` maps to exit code 2 (usage or spec-load problem); any other
 * unexpected error maps to exit code 1.
 */

/** A usage or spec-load problem. The caller exits with code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A failure to read, fetch, or validate an OpenAPI document (exit code 2). */
export class SpecLoadError extends UsageError {
  /** The path or URL that could not be loaded. */
  readonly source: string;

  constructor(source: string, message: string, options?: { cause?: unknown }) {
    super(`failed to load spec "${source}": ${message}`);
    this.name = "SpecLoadError";
    this.source = source;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
