/**
 * Upstream HTTP request building and execution (task 2.4).
 *
 * `buildRequest` is a pure function: it validates tool arguments and returns
 * the URL/init pair that would be sent upstream. `executeTool` performs the
 * call via the injectable `fetch` surface and never throws — every failure is
 * normalized into an `isError` tool result so the MCP server stays alive.
 *
 * STDOUT IS THE MCP TRANSPORT: this module never writes to stdout. Warnings go
 * through `./logger.js`, and header/argument values are never logged.
 */

import type { ParsedTool, RequestBodyPlan } from "../core/index.js";

import { warn } from "./logger.js";

/** One MCP content block: text, or a base64 image for `image/*` responses. */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** MCP tool-call result payload. */
export interface ToolResult {
  content: ToolContent[];
  isError?: true;
}

/** Injectable fetch surface used by tests and the runner. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: "manual";
  },
) => Promise<Response>;

/** Invalid tool arguments discovered during pre-flight validation. */
export class RequestValidationError extends Error {}

/** A fully built upstream request. */
export interface BuiltRequest {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

/** Maximum number of response characters returned to the MCP client. */
export const MAX_RESPONSE_CHARS = 256_000;

/**
 * Maximum number of response bytes read from upstream; the rest of the stream
 * is cancelled. UTF-8 needs at most 4 bytes per character, so any text cut by
 * this cap is also over {@link MAX_RESPONSE_CHARS} and gets the usual marker.
 */
export const MAX_RESPONSE_BYTES = MAX_RESPONSE_CHARS * 4;

/** Maximum number of redirects followed for one tool call. */
export const MAX_REDIRECTS = 5;

/** Statuses that carry a `Location` to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Headers that carry credentials and must never follow a cross-origin
 * redirect, in addition to every header injected with `--header`.
 */
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie"];

/** Options for executing a tool call. */
export interface ExecuteOptions {
  cliHeaders: Record<string, string>;
  baseUrl: string | null;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  /** Aborted when the MCP client cancels the tool call. */
  signal?: AbortSignal;
}

/** Whether `value` is a plain (non-array, non-null, non-class-instance) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Lowercased media type with parameters stripped, e.g.
 * `"Application/JSON; charset=utf-8"` -> `"application/json"`.
 */
function baseContentType(contentType: string): string {
  const [base] = contentType.split(";");
  return (base ?? "").trim().toLowerCase();
}

/** JSON media types: `application/json` and any `application/*json`. */
function isJsonContentType(base: string): boolean {
  return base === "application/json" || (base.startsWith("application/") && base.endsWith("json"));
}

/** Form-encoded media type. */
function isFormContentType(base: string): boolean {
  return base === "application/x-www-form-urlencoded";
}

/** Whether a request body plan uses a content type this runner can serialize. */
function isSupportedContentType(contentType: string): boolean {
  const base = baseContentType(contentType);
  return isJsonContentType(base) || isFormContentType(base);
}

/** Remove every key that matches `name` case-insensitively. */
function deleteHeader(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
}

/** Set a header, replacing any existing key that matches case-insensitively. */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  deleteHeader(headers, name);
  headers[name] = value;
}

/**
 * Names exposed as body arguments: merged bodies use every `inputSchema`
 * property that is not a parameter; nested bodies use only the `bodyKey`.
 */
function bodyArgumentNames(tool: ParsedTool): string[] {
  const requestBody = tool.metadata.requestBody;
  if (!requestBody) {
    return [];
  }
  if (requestBody.embedding === "nested") {
    return [requestBody.bodyKey ?? "body"];
  }
  const parameterNames = new Set(tool.metadata.parameters.map((p) => p.name));
  return Object.keys(tool.inputSchema.properties).filter((name) => !parameterNames.has(name));
}

/**
 * Extract the body value from arguments.
 *
 * Returns an object for merged bodies (possibly empty) and the raw `bodyKey`
 * argument (possibly `undefined`) for nested bodies.
 */
function extractBodyValue(tool: ParsedTool, args: Record<string, unknown>): unknown {
  const requestBody = tool.metadata.requestBody;
  if (!requestBody) {
    return undefined;
  }
  if (requestBody.embedding === "nested") {
    return args[requestBody.bodyKey ?? "body"];
  }
  const parameterNames = new Set(tool.metadata.parameters.map((p) => p.name));
  const value: Record<string, unknown> = {};
  for (const [key, argValue] of Object.entries(args)) {
    if (!parameterNames.has(key) && argValue !== undefined) {
      value[key] = argValue;
    }
  }
  return value;
}

/** Whether `extractBodyValue` produced something that should be serialized. */
function hasBodyValue(tool: ParsedTool, bodyValue: unknown): boolean {
  if (tool.metadata.requestBody?.embedding === "nested") {
    return bodyValue !== undefined;
  }
  return isPlainObject(bodyValue) && Object.keys(bodyValue).length > 0;
}

/** Append one form field; arrays become repeated keys, objects are rejected. */
function appendFormField(params: URLSearchParams, field: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined || item === null) {
        continue;
      }
      if (isPlainObject(item) || Array.isArray(item)) {
        throw new RequestValidationError(
          `form body field ${field} must be a primitive or array of primitives`,
        );
      }
      params.append(field, String(item));
    }
    return;
  }
  if (isPlainObject(value)) {
    throw new RequestValidationError(
      `form body field ${field} must be a primitive or array of primitives`,
    );
  }
  params.append(field, String(value));
}

/** Serialize a body argument value as a JSON request body. */
function serializeJsonBody(requestBody: RequestBodyPlan, bodyValue: unknown): string {
  if (requestBody.embedding === "nested" && typeof bodyValue === "string") {
    try {
      return JSON.stringify(JSON.parse(bodyValue));
    } catch {
      return bodyValue;
    }
  }
  return JSON.stringify(bodyValue);
}

/** Serialize a body argument value as an `application/x-www-form-urlencoded` body. */
function serializeFormBody(requestBody: RequestBodyPlan, bodyValue: unknown): string {
  const params = new URLSearchParams();
  if (requestBody.embedding === "nested") {
    if (!isPlainObject(bodyValue)) {
      throw new RequestValidationError("form body must be a plain object");
    }
    for (const [key, value] of Object.entries(bodyValue)) {
      appendFormField(params, key, value);
    }
    return params.toString();
  }
  if (!isPlainObject(bodyValue)) {
    return "";
  }
  for (const [key, value] of Object.entries(bodyValue)) {
    appendFormField(params, key, value);
  }
  return params.toString();
}

/** Pre-flight validation: unknown arguments, missing required, content type. */
function validateArguments(tool: ParsedTool, args: Record<string, unknown>): void {
  const parameterNames = new Set(tool.metadata.parameters.map((p) => p.name));
  const allowed = new Set<string>(parameterNames);
  for (const name of bodyArgumentNames(tool)) {
    allowed.add(name);
  }

  const unknown = Object.keys(args).filter((name) => !allowed.has(name));
  if (unknown.length === 1) {
    throw new RequestValidationError(`unknown argument: ${unknown[0]}`);
  }
  if (unknown.length > 1) {
    throw new RequestValidationError(`unknown arguments: ${unknown.join(", ")}`);
  }

  const missing = tool.inputSchema.required.filter(
    (name) => args[name] === undefined,
  );
  if (missing.length === 1) {
    throw new RequestValidationError(`missing required argument: ${missing[0]}`);
  }
  if (missing.length > 1) {
    throw new RequestValidationError(`missing required arguments: ${missing.join(", ")}`);
  }

  const requestBody = tool.metadata.requestBody;
  if (requestBody && !isSupportedContentType(requestBody.contentType)) {
    const bodyValue = extractBodyValue(tool, args);
    if (requestBody.required || hasBodyValue(tool, bodyValue)) {
      throw new RequestValidationError(`unsupported content type: ${requestBody.contentType}`);
    }
  }
}

/** Encode one path parameter value (`a b/c` -> `a%20b%2Fc`). */
function encodePathValue(name: string, value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => encodeURIComponent(String(item))).join(",");
  }
  if (isPlainObject(value)) {
    throw new RequestValidationError(`path parameter ${name} must be a primitive or array`);
  }
  return encodeURIComponent(String(value));
}

/** Build a request from tool metadata and arguments. Throws RequestValidationError. */
export function buildRequest(
  tool: ParsedTool,
  args: Record<string, unknown>,
  cliHeaders: Record<string, string>,
  baseUrl: string,
): BuiltRequest {
  validateArguments(tool, args);

  // Path substitution.
  const path = tool.metadata.pathTemplate.replace(/\{([^}]+)\}/g, (token, name: string) => {
    const value = args[name];
    if (value === undefined || value === null) {
      return token;
    }
    return encodePathValue(name, value);
  });
  const unfilled = /\{([^}]+)\}/.exec(path);
  if (unfilled) {
    throw new RequestValidationError(`missing path parameter: ${unfilled[1]}`);
  }

  // Query string.
  const search = new URLSearchParams();
  for (const parameter of tool.metadata.parameters) {
    if (parameter.in !== "query") {
      continue;
    }
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) {
          continue;
        }
        if (isPlainObject(item)) {
          warn(
            `query parameter "${parameter.name}" contains an object; deepObject serialization is not supported, omitting it`,
          );
          continue;
        }
        search.append(parameter.name, String(item));
      }
      continue;
    }
    if (isPlainObject(value)) {
      warn(
        `query parameter "${parameter.name}" is an object; deepObject serialization is not supported, omitting it`,
      );
      continue;
    }
    search.append(parameter.name, String(value));
  }
  const queryString = search.toString();

  // Headers: defaults, then spec params, then body content type, then CLI.
  const headers: Record<string, string> = {};
  setHeader(headers, "Accept", "application/json");
  for (const parameter of tool.metadata.parameters) {
    if (parameter.in !== "header") {
      continue;
    }
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      continue;
    }
    let headerValue: string;
    if (Array.isArray(value)) {
      headerValue = value.map((item) => String(item)).join(",");
    } else if (isPlainObject(value)) {
      headerValue = JSON.stringify(value);
    } else {
      headerValue = String(value);
    }
    setHeader(headers, parameter.name, headerValue);
  }

  // Body.
  const requestBody = tool.metadata.requestBody;
  let body: string | undefined;
  if (requestBody) {
    const bodyValue = extractBodyValue(tool, args);
    const sendBody =
      hasBodyValue(tool, bodyValue) ||
      (requestBody.required && requestBody.embedding === "merged");
    if (sendBody) {
      const base = baseContentType(requestBody.contentType);
      if (isFormContentType(base)) {
        body = serializeFormBody(requestBody, bodyValue);
      } else {
        body = serializeJsonBody(requestBody, bodyValue);
      }
      setHeader(headers, "Content-Type", requestBody.contentType);
    }
  }

  // CLI headers win, case-insensitively.
  for (const [name, value] of Object.entries(cliHeaders)) {
    setHeader(headers, name, value);
  }

  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const url = `${trimmedBase}${path}${queryString ? `?${queryString}` : ""}`;

  const init: BuiltRequest["init"] = {
    method: tool.metadata.method.toUpperCase(),
    headers,
  };
  if (body !== undefined) {
    init.body = body;
  }
  return { url, init };
}

/** Truncate long response text and append the truncation marker. */
function truncate(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_RESPONSE_CHARS)}\n\n[apibear] response truncated at ${MAX_RESPONSE_CHARS} characters`;
}

/** A response body read up to {@link MAX_RESPONSE_BYTES}. */
interface CappedBody {
  bytes: Uint8Array;
  /** Whether the upstream body was longer than the cap. */
  truncated: boolean;
}

/**
 * Read at most `maxBytes` of a response body, cancelling the rest of the
 * stream, so a huge download cannot exhaust memory. Throws if the stream fails.
 */
async function readCappedBody(res: Response, maxBytes: number): Promise<CappedBody> {
  const stream = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (stream === null || stream === undefined) {
    // No stream (e.g. a `null` body, or a minimal Response-like object).
    const bytes = new TextEncoder().encode(await res.text());
    return bytes.byteLength > maxBytes
      ? { bytes: bytes.subarray(0, maxBytes), truncated: true }
      : { bytes, truncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

/** Media types that are text even though they are not `text/*`. */
function isTextualContentType(base: string): boolean {
  if (base === "" || base.startsWith("text/")) {
    return true;
  }
  return /json|xml|javascript|ecmascript|yaml|csv|html|graphql|x-www-form-urlencoded/.test(base);
}

/** Raster images that can be returned to the client as MCP image content. */
function isImageContentType(base: string): boolean {
  return base.startsWith("image/") && base !== "image/svg+xml";
}

/**
 * Decode body bytes as UTF-8. Declared-text types decode leniently; anything
 * else must be valid UTF-8 or it is treated as binary (returns `null`).
 */
function decodeBody(body: CappedBody, base: string): string | null {
  if (isTextualContentType(base)) {
    return new TextDecoder().decode(body.bytes);
  }
  try {
    // `stream: true` buffers a multi-byte character cut by the byte cap
    // instead of treating it as invalid.
    return new TextDecoder("utf-8", { fatal: true }).decode(body.bytes, { stream: body.truncated });
  } catch {
    return null;
  }
}

/** One-line description of a binary body that is not sent to the model. */
function describeBinary(base: string, body: CappedBody): string {
  const size = body.truncated
    ? `more than ${MAX_RESPONSE_BYTES} bytes`
    : `${body.bytes.byteLength} bytes`;
  return `(binary response: ${base || "unknown content type"}, ${size}; not shown)`;
}

/** `HTTP 429 Too Many Requests`, plus `Retry-After` when the upstream sent one. */
function statusLine(res: Response): string {
  let line = res.statusText ? `HTTP ${res.status} ${res.statusText}` : `HTTP ${res.status}`;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null && retryAfter.trim() !== "") {
    line += ` (Retry-After: ${retryAfter.trim()})`;
  }
  return line;
}

/** Normalize an upstream response into a tool result. */
export async function normalizeResponse(res: Response): Promise<ToolResult> {
  let body: CappedBody;
  try {
    body = await readCappedBody(res, MAX_RESPONSE_BYTES);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `request failed: ${reason}` }], isError: true };
  }

  const base = baseContentType(res.headers.get("content-type") ?? "");

  if (res.ok && isImageContentType(base) && !body.truncated && body.bytes.byteLength > 0) {
    return {
      content: [{ type: "image", data: Buffer.from(body.bytes).toString("base64"), mimeType: base }],
    };
  }

  const decoded = decodeBody(body, base);
  let text: string;
  if (decoded === null) {
    text = describeBinary(base, body);
  } else {
    text = decoded;
    if (base.includes("json")) {
      try {
        text = JSON.stringify(JSON.parse(decoded));
      } catch {
        text = decoded;
      }
    }
    text = truncate(text);
  }

  if (res.ok) {
    if (text === "") {
      text = `(empty response body, HTTP ${res.status})`;
    }
    return { content: [{ type: "text", text }] };
  }

  const status = statusLine(res);
  text = text === "" ? status : `${status}\n\n${text}`;
  return { content: [{ type: "text", text }], isError: true };
}

/** A redirect that cannot be followed; reported as `request failed:`. */
class RedirectError extends Error {}

/**
 * Perform the request, following up to {@link MAX_REDIRECTS} redirects by hand.
 *
 * `fetch`'s automatic redirects forward custom headers (`X-API-Key`, ...) to
 * whatever host the `Location` names. Here, once a redirect leaves the
 * original origin, every `--header` value and every standard credential
 * header is dropped for the rest of the chain.
 */
async function fetchWithRedirects(
  fetchImpl: FetchLike,
  request: BuiltRequest,
  cliHeaders: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  let url = request.url;
  let method = request.init.method;
  let body = request.init.body;
  const headers = { ...request.init.headers };

  for (let redirects = 0; ; redirects += 1) {
    const res = await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal,
    });

    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
    if (location === null) {
      return res;
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new RedirectError(`too many redirects (more than ${MAX_REDIRECTS})`);
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new RedirectError(`HTTP ${res.status} redirect has an invalid Location`);
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new RedirectError(`HTTP ${res.status} redirect to unsupported scheme ${next.protocol}`);
    }
    await res.body?.cancel().catch(() => undefined);

    // Fetch spec: 303 (except HEAD), and 301/302 after POST, become a bodyless GET.
    if ((res.status === 303 && method !== "HEAD") || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      deleteHeader(headers, "Content-Type");
    }

    if (next.origin !== origin) {
      for (const name of [...Object.keys(cliHeaders), ...CREDENTIAL_HEADERS]) {
        deleteHeader(headers, name);
      }
    }
    url = next.href;
  }
}

/** One signal that aborts when any of `signals` does (`AbortSignal.any` needs Node 20.3). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1 && signals[0] !== undefined) {
    return signals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Render a caught fetch failure as a user-facing `request failed:` message. */
function describeNetworkError(error: unknown, timeoutMs: number, clientSignal?: AbortSignal): string {
  if (clientSignal?.aborted === true) {
    return "request failed: cancelled by the client";
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `request failed: timed out after ${timeoutMs}ms`;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string" && code !== "") {
        return `request failed: ${code} ${error.message}`;
      }
    }
    return `request failed: ${error.message}`;
  }
  return `request failed: ${String(error)}`;
}

/** Build a one-line `isError` tool result. */
function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Execute one tool call. Never throws; failures become `isError` results. */
export async function executeTool(
  tool: ParsedTool,
  args: Record<string, unknown>,
  opts: ExecuteOptions,
): Promise<ToolResult> {
  try {
    const baseUrl = opts.baseUrl ?? tool.metadata.baseUrl;
    if (!baseUrl) {
      return errorResult(
        `no base URL available for tool "${tool.name}": the spec has no usable absolute server URL, pass --base-url`,
      );
    }

    let request: BuiltRequest;
    try {
      request = buildRequest(tool, args, opts.cliHeaders, baseUrl);
    } catch (error) {
      if (error instanceof RequestValidationError) {
        return errorResult(error.message);
      }
      throw error;
    }

    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = anySignal(opts.signal === undefined ? [timeout] : [timeout, opts.signal]);
    try {
      const res = await fetchWithRedirects(fetchImpl, request, opts.cliHeaders, signal);
      return await normalizeResponse(res);
    } catch (error) {
      return errorResult(describeNetworkError(error, opts.timeoutMs, opts.signal));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`internal error: ${message}`);
  }
}
