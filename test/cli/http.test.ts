import { createServer } from "node:http";
import type { Server } from "node:http";

import type { ParsedTool } from "../../src/core/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_RESPONSE_CHARS,
  RequestValidationError,
  buildRequest,
  executeTool,
  normalizeResponse,
} from "../../src/cli/http.js";
import type { ExecuteOptions, FetchLike, ToolResult } from "../../src/cli/http.js";

/** Start `server` on an ephemeral loopback port. */
function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

/** Port a listening loopback server is bound to. */
function port(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

/** Stop `server`. */
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Text of the first content block, or `undefined` when it is not text. */
function textOf(result: ToolResult): string | undefined {
  const first = result.content[0];
  return first?.type === "text" ? first.text : undefined;
}

/**
 * Build a hand-crafted ParsedTool. Defaults describe a bodyless GET; pass
 * metadata/inputSchema overrides for each scenario.
 */
function makeTool(
  metadata: Partial<ParsedTool["metadata"]> = {},
  overrides: Partial<Omit<ParsedTool, "metadata">> = {},
): ParsedTool {
  return {
    name: overrides.name ?? "testTool",
    ...(overrides.description !== undefined ? { description: overrides.description } : {}),
    inputSchema: overrides.inputSchema ?? {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    metadata: {
      operationId: metadata.operationId ?? "testOperation",
      method: metadata.method ?? "get",
      pathTemplate: metadata.pathTemplate ?? "/things",
      baseUrl: metadata.baseUrl === undefined ? "https://api.example.com" : metadata.baseUrl,
      parameters: metadata.parameters ?? [],
      requestBody: metadata.requestBody === undefined ? null : metadata.requestBody,
      securityHeaderNames: metadata.securityHeaderNames ?? [],
      deprecated: metadata.deprecated ?? false,
    },
  };
}

/** A tool with one required path parameter. */
function pathTool(pathTemplate = "/pets/{petId}"): ParsedTool {
  return makeTool(
    {
      pathTemplate,
      parameters: [{ name: "petId", in: "path", required: true }],
    },
    {
      inputSchema: {
        type: "object",
        properties: { petId: { type: "string" } },
        required: ["petId"],
        additionalProperties: false,
      },
    },
  );
}

/** Options for executeTool with a null base URL unless overridden. */
function options(overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    cliHeaders: {},
    baseUrl: null,
    timeoutMs: 1_000,
    ...overrides,
  };
}

/** Capture every header key matching `name` case-insensitively. */
function headerKeys(headers: Record<string, string>, name: string): string[] {
  const lower = name.toLowerCase();
  return Object.keys(headers).filter((key) => key.toLowerCase() === lower);
}

/** Find a header value case-insensitively. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = headerKeys(headers, name)[0];
  return key === undefined ? undefined : headers[key];
}

/** Parse a built URL's search string into a map of repeated values. */
function queryOf(url: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, value] of new URL(url).searchParams) {
    const values = result.get(key) ?? [];
    values.push(value);
    result.set(key, values);
  }
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildRequest: path substitution", () => {
  it("substitutes and percent-encodes path parameters", () => {
    const request = buildRequest(pathTool(), { petId: "a b/c" }, {}, "https://api.example.com");

    expect(request.url).toBe("https://api.example.com/pets/a%20b%2Fc");
    expect(request.init.method).toBe("GET");
  });

  it("joins array path parameters with commas, encoding each element", () => {
    const tool = makeTool(
      {
        pathTemplate: "/by/{ids}",
        parameters: [{ name: "ids", in: "path", required: true }],
      },
      {
        inputSchema: {
          type: "object",
          properties: { ids: { type: "array", items: { type: "string" } } },
          required: ["ids"],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(tool, { ids: ["a b", "c/d"] }, {}, "https://api.example.com");

    expect(request.url).toBe("https://api.example.com/by/a%20b,c%2Fd");
  });

  it("rejects an unfilled path token", () => {
    const tool = makeTool({ pathTemplate: "/pets/{petId}" });

    expect(() => buildRequest(tool, {}, {}, "https://api.example.com")).toThrowError(
      new RequestValidationError("missing path parameter: petId"),
    );
  });

  it("rejects plain-object path parameter values", () => {
    const tool = pathTool();

    expect(() =>
      buildRequest(tool, { petId: { nested: true } }, {}, "https://api.example.com"),
    ).toThrowError("path parameter petId must be a primitive or array");
  });
});

describe("buildRequest: query parameters", () => {
  const tool = makeTool({
    parameters: [
      { name: "tags", in: "query", required: false },
      { name: "flag", in: "query", required: false },
      { name: "skip", in: "query", required: false },
      { name: "gone", in: "query", required: false },
    ],
  });

  it("repeats array keys, stringifies booleans, and omits null/undefined", () => {
    const request = buildRequest(
      tool,
      { tags: ["a b", "c"], flag: true, skip: null, gone: undefined },
      {},
      "https://api.example.com",
    );
    const query = queryOf(request.url);

    expect(query.get("tags")).toEqual(["a b", "c"]);
    expect(query.get("flag")).toEqual(["true"]);
    expect(query.has("skip")).toBe(false);
    expect(query.has("gone")).toBe(false);
  });

  it("omits plain-object query values with a stderr warning naming the parameter", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const objectTool = makeTool({
      parameters: [{ name: "filter", in: "query", required: false }],
    });

    const request = buildRequest(objectTool, { filter: { a: 1 } }, {}, "https://api.example.com");

    expect(queryOf(request.url).has("filter")).toBe(false);
    expect(stderr).toHaveBeenCalledTimes(1);
    const message = String(stderr.mock.calls[0]?.[0]);
    expect(message).toContain("filter");
    expect(message).toContain("deepObject");
    // Never log argument values.
    expect(message).not.toContain("a: 1");
  });

  it("omits the query string entirely when no query args are present", () => {
    const request = buildRequest(tool, {}, {}, "https://api.example.com");

    expect(request.url).toBe("https://api.example.com/things");
  });
});

describe("buildRequest: validation", () => {
  it("rejects a single unknown argument", () => {
    const tool = makeTool();

    expect(() => buildRequest(tool, { foo: 1 }, {}, "https://api.example.com")).toThrowError(
      "unknown argument: foo",
    );
  });

  it("rejects multiple unknown arguments in one message", () => {
    const tool = makeTool();

    expect(() => buildRequest(tool, { foo: 1, bar: 2 }, {}, "https://api.example.com")).toThrowError(
      "unknown arguments: foo, bar",
    );
  });

  it("lists every missing required argument", () => {
    const tool = makeTool(
      { parameters: [{ name: "a", in: "query", required: true }, { name: "b", in: "query", required: true }] },
      {
        inputSchema: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
      },
    );

    expect(() => buildRequest(tool, {}, {}, "https://api.example.com")).toThrowError(
      "missing required arguments: a, b",
    );
  });

  it("treats an undefined argument as missing", () => {
    expect(() =>
      buildRequest(pathTool(), { petId: undefined }, {}, "https://api.example.com"),
    ).toThrowError("missing required argument: petId");
  });

  it("does not perform a fetch when validation fails", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const tool = makeTool({ baseUrl: "https://api.example.com" });

    const result = await executeTool(tool, { nope: true }, options({ fetchImpl }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("unknown argument: nope");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("buildRequest: body extraction", () => {
  const mergedTool = makeTool(
    {
      method: "post",
      pathTemplate: "/pets",
      requestBody: { required: true, contentType: "application/json", embedding: "merged" },
    },
    {
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, tag: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  );

  it("rebuilds a merged JSON body from non-parameter arguments", () => {
    const request = buildRequest(
      mergedTool,
      { name: "Rex", tag: "dog" },
      {},
      "https://api.example.com",
    );

    expect(request.init.body).toBe('{"name":"Rex","tag":"dog"}');
    expect(headerValue(request.init.headers, "content-type")).toBe("application/json");
  });

  it("excludes parameter names from a merged body", () => {
    const tool = makeTool(
      {
        method: "post",
        parameters: [{ name: "limit", in: "query", required: false }],
        requestBody: { required: false, contentType: "application/json", embedding: "merged" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer" }, name: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(tool, { limit: 5, name: "Rex" }, {}, "https://api.example.com");

    expect(request.init.body).toBe('{"name":"Rex"}');
    expect(queryOf(request.url).get("limit")).toEqual(["5"]);
  });

  it("passes a nested body through as JSON", () => {
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: true, contentType: "application/json", embedding: "nested", bodyKey: "body" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { body: { type: "object" } },
          required: ["body"],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(tool, { body: { a: 1 } }, {}, "https://api.example.com");

    expect(request.init.body).toBe('{"a":1}');
  });

  it("parses a nested string body as JSON before re-stringifying", () => {
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: true, contentType: "application/json", embedding: "nested", bodyKey: "body" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { body: { type: "object" } },
          required: ["body"],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(tool, { body: '{ "a" : 1 }' }, {}, "https://api.example.com");

    expect(request.init.body).toBe('{"a":1}');
  });

  it("sends an unparseable nested string body raw", () => {
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: true, contentType: "application/json", embedding: "nested", bodyKey: "body" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(tool, { body: "{not json" }, {}, "https://api.example.com");

    expect(request.init.body).toBe("{not json");
  });

  it("omits the body when an optional body is absent", () => {
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: false, contentType: "application/json", embedding: "merged" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { tag: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(tool, {}, {}, "https://api.example.com");

    expect(request.init.body).toBeUndefined();
    expect(headerValue(request.init.headers, "content-type")).toBeUndefined();
    expect("body" in request.init).toBe(false);
  });

  it("sends {} for a required merged JSON body with no fields", () => {
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: true, contentType: "application/json", embedding: "merged" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { tag: { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(tool, {}, {}, "https://api.example.com");

    expect(request.init.body).toBe("{}");
    expect(headerValue(request.init.headers, "content-type")).toBe("application/json");
  });

  it("attaches no body to bodyless methods", () => {
    const request = buildRequest(makeTool(), {}, {}, "https://api.example.com");

    expect("body" in request.init).toBe(false);
    expect(request.init.method).toBe("GET");
  });
});

describe("buildRequest: form bodies", () => {
  function formTool(embedding: "merged" | "nested", required = true): ParsedTool {
    return makeTool(
      {
        method: "post",
        requestBody: {
          required,
          contentType: "application/x-www-form-urlencoded",
          embedding,
          ...(embedding === "nested" ? { bodyKey: "body" } : {}),
        },
      },
      {
        inputSchema: {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" } },
            limit: { type: "integer" },
            nested: { type: "object" },
            items: { type: "array", items: { type: "object" } },
            body: { type: "object" },
          },
          required: [],
          additionalProperties: false,
        },
      },
    );
  }

  it("encodes form fields with repeated array keys", () => {
    const request = buildRequest(
      formTool("merged"),
      { tags: ["a", "b"], limit: 3 },
      {},
      "https://api.example.com",
    );

    expect(request.init.body).toBe("tags=a&tags=b&limit=3");
    expect(headerValue(request.init.headers, "content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("sends an empty form body when a required merged body has no fields", () => {
    const request = buildRequest(formTool("merged"), {}, {}, "https://api.example.com");

    expect(request.init.body).toBe("");
    expect(headerValue(request.init.headers, "content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("rejects nested objects in form bodies", () => {
    expect(() =>
      buildRequest(formTool("merged"), { nested: { a: 1 } }, {}, "https://api.example.com"),
    ).toThrowError("form body field nested must be a primitive or array of primitives");
  });

  it("rejects arrays of objects in form bodies", () => {
    expect(() =>
      buildRequest(formTool("merged"), { items: [{ a: 1 }] }, {}, "https://api.example.com"),
    ).toThrowError("form body field items must be a primitive or array of primitives");
  });

  it("requires a plain object for a nested form body", () => {
    expect(() =>
      buildRequest(formTool("nested"), { body: "not-an-object" }, {}, "https://api.example.com"),
    ).toThrowError("form body must be a plain object");
  });

  it("encodes a nested form body object", () => {
    const request = buildRequest(
      formTool("nested"),
      { body: { tags: ["x", "y"], limit: 2 } },
      {},
      "https://api.example.com",
    );

    expect(request.init.body).toBe("tags=x&tags=y&limit=2");
  });
});

describe("buildRequest: headers", () => {
  it("defaults Accept to application/json and stringifies header params", () => {
    const tool = makeTool(
      { parameters: [{ name: "X-Trace", in: "header", required: false }] },
      {
        inputSchema: {
          type: "object",
          properties: { "X-Trace": { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(tool, { "X-Trace": "abc" }, {}, "https://api.example.com");

    expect(headerValue(request.init.headers, "accept")).toBe("application/json");
    expect(headerValue(request.init.headers, "x-trace")).toBe("abc");
  });

  it("applies CLI headers last, case-insensitively, without duplicate keys", () => {
    const tool = makeTool(
      { parameters: [{ name: "X-Api-Key", in: "header", required: false }] },
      {
        inputSchema: {
          type: "object",
          properties: { "X-Api-Key": { type: "string" } },
          required: [],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(
      tool,
      { "X-Api-Key": "spec-value" },
      { "x-api-key": "cli-value", accept: "text/plain" },
      "https://api.example.com",
    );

    expect(headerKeys(request.init.headers, "x-api-key")).toEqual(["x-api-key"]);
    expect(headerValue(request.init.headers, "x-api-key")).toBe("cli-value");
    expect(headerKeys(request.init.headers, "accept")).toEqual(["accept"]);
    expect(headerValue(request.init.headers, "accept")).toBe("text/plain");
  });

  it("lets CLI headers override the generated Content-Type", () => {
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: true, contentType: "application/json", embedding: "merged" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    );

    const request = buildRequest(
      tool,
      { name: "Rex" },
      { "Content-Type": "application/vnd.custom+json" },
      "https://api.example.com",
    );

    expect(headerKeys(request.init.headers, "content-type")).toEqual(["Content-Type"]);
    expect(headerValue(request.init.headers, "content-type")).toBe("application/vnd.custom+json");
    expect(request.init.body).toBe('{"name":"Rex"}');
  });
});

describe("buildRequest: unsupported content types", () => {
  function multipartTool(required: boolean): ParsedTool {
    return makeTool(
      {
        method: "post",
        requestBody: { required, contentType: "multipart/form-data", embedding: "merged" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: required ? ["name"] : [],
          additionalProperties: false,
        },
      },
    );
  }

  it("rejects an unsupported content type when the body is required", () => {
    expect(() => buildRequest(multipartTool(true), { name: "x" }, {}, "https://api.example.com")).toThrowError(
      "unsupported content type: multipart/form-data",
    );
  });

  it("rejects an unsupported content type when a body arg is present", () => {
    expect(() => buildRequest(multipartTool(false), { name: "x" }, {}, "https://api.example.com")).toThrowError(
      "unsupported content type: multipart/form-data",
    );
  });

  it("allows a missing optional unsupported body", () => {
    const request = buildRequest(multipartTool(false), {}, {}, "https://api.example.com");

    expect("body" in request.init).toBe(false);
  });

  it("surfaces the unsupported content type as an isError result without fetching", async () => {
    const fetchImpl = vi.fn<FetchLike>();

    const result = await executeTool(
      multipartTool(true),
      { name: "x" },
      options({ fetchImpl, baseUrl: "https://api.example.com" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("unsupported content type: multipart/form-data");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("buildRequest: URLs", () => {
  it("strips trailing slashes from the base URL", () => {
    const request = buildRequest(makeTool(), {}, {}, "https://api.example.com///");

    expect(request.url).toBe("https://api.example.com/things");
  });
});

describe("executeTool", () => {
  it("errors clearly when no base URL is available", async () => {
    const tool = makeTool({ baseUrl: null });

    const result = await executeTool(tool, {}, options());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no base URL available for tool "testTool"');
    expect(textOf(result)).toContain("--base-url");
  });

  it("prefers the override base URL over metadata", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("{}", { status: 200 }));
    const tool = makeTool({ baseUrl: "https://spec.example.com" });

    const result = await executeTool(
      tool,
      {},
      options({ fetchImpl, baseUrl: "https://override.example.com/api/" }),
    );

    expect(result.isError).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://override.example.com/api/things");
  });

  it("passes method, headers, and body to fetch", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("ok", { status: 200 }));
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: true, contentType: "application/json", embedding: "merged" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    );

    await executeTool(
      tool,
      { name: "Rex" },
      options({ fetchImpl, baseUrl: "https://api.example.com", cliHeaders: { "X-Key": "v" } }),
    );

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"name":"Rex"}');
    expect(init?.headers).toMatchObject({ "X-Key": "v", "Content-Type": "application/json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a JSON response as compact text without isError", async () => {
    const fetchImpl = vi.fn<FetchLike>(
      async () =>
        new Response('{\n  "a": 1\n}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await executeTool(
      makeTool(),
      {},
      options({ fetchImpl, baseUrl: "https://api.example.com" }),
    );

    expect(textOf(result)).toBe('{"a":1}');
    expect("isError" in result).toBe(false);
  });

  it("classifies a refused connection as request failed", async () => {
    const error = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw error;
    });

    const result = await executeTool(
      makeTool(),
      {},
      options({ fetchImpl, baseUrl: "https://api.example.com" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("request failed: ECONNREFUSED fetch failed");
  });

  it("reports timeouts with the configured duration", async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const result = await executeTool(
      makeTool(),
      {},
      options({ fetchImpl, baseUrl: "https://api.example.com", timeoutMs: 20 }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("request failed: timed out after 20ms");
  });

  it("never throws when fetch throws synchronously", async () => {
    const fetchImpl = (() => {
      throw new Error("sync boom");
    }) as unknown as FetchLike;

    const result = await executeTool(
      makeTool(),
      {},
      options({ fetchImpl, baseUrl: "https://api.example.com" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("request failed: sync boom");
  });

  it("wraps unexpected errors as internal errors", async () => {
    const tool = makeTool();
    Object.defineProperty(tool.metadata, "parameters", {
      get() {
        throw new Error("kaboom");
      },
    });

    const result = await executeTool(tool, {}, options({ baseUrl: "https://api.example.com" }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("internal error: kaboom");
  });

  it("never writes to stdout", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("ok", { status: 200 }));

    await executeTool(
      makeTool({ parameters: [{ name: "filter", in: "query", required: false }] }),
      { filter: { a: 1 } },
      options({ fetchImpl, baseUrl: "https://api.example.com" }),
    );
    await executeTool(makeTool(), { bogus: 1 }, options({ baseUrl: "https://api.example.com" }));

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  });
});

describe("normalizeResponse", () => {
  it("compacts valid JSON bodies", async () => {
    const result = await normalizeResponse(
      new Response('{\n "a": 1, "b": [1, 2]\n}', {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );

    expect(textOf(result)).toBe('{"a":1,"b":[1,2]}');
    expect("isError" in result).toBe(false);
  });

  it("compacts +json media types", async () => {
    const result = await normalizeResponse(
      new Response('{ "a": 1 }', {
        status: 200,
        headers: { "content-type": "application/vnd.api+json" },
      }),
    );

    expect(textOf(result)).toBe('{"a":1}');
  });

  it("keeps non-JSON bodies raw", async () => {
    const result = await normalizeResponse(
      new Response("hello\nworld", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    expect(textOf(result)).toBe("hello\nworld");
  });

  it("keeps invalid JSON raw when the content type claims JSON", async () => {
    const result = await normalizeResponse(
      new Response("{oops", { status: 200, headers: { "content-type": "application/json" } }),
    );

    expect(textOf(result)).toBe("{oops");
  });

  it("truncates bodies above the cap and appends the marker", async () => {
    const body = "x".repeat(MAX_RESPONSE_CHARS + 100);
    const result = await normalizeResponse(
      new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const text = textOf(result);

    expect(MAX_RESPONSE_CHARS).toBe(256_000);
    expect(text).toHaveLength(MAX_RESPONSE_CHARS + "\n\n[apibear] response truncated at 256000 characters".length);
    expect(text?.endsWith("[apibear] response truncated at 256000 characters")).toBe(true);
  });

  it("does not truncate bodies at exactly the cap", async () => {
    const body = "y".repeat(MAX_RESPONSE_CHARS);
    const result = await normalizeResponse(
      new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
    );

    expect(textOf(result)).toHaveLength(MAX_RESPONSE_CHARS);
  });

  it("prefixes non-ok responses with the status line and keeps the body", async () => {
    const result = await normalizeResponse(
      new Response("nope", { status: 404, statusText: "Not Found" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("HTTP 404 Not Found\n\nnope");
  });

  it("omits the status text when it is empty", async () => {
    const result = await normalizeResponse(new Response("boom", { status: 404, statusText: "" }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("HTTP 404\n\nboom");
  });

  it("describes an empty success body with the status code", async () => {
    const result = await normalizeResponse(new Response(null, { status: 204 }));

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe("(empty response body, HTTP 204)");
  });

  it("returns just the status line for an empty error body", async () => {
    const result = await normalizeResponse(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("HTTP 500 Internal Server Error");
  });

  it("reports a body read failure as request failed", async () => {
    const fake = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: () => Promise.reject(new Error("stream exploded")),
    } as unknown as Response;

    const result = await normalizeResponse(fake);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("request failed: stream exploded");
  });

  it("stops reading at the byte cap and cancels the rest of the stream", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x61); // "a"
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await normalizeResponse(
      new Response(stream, { status: 200, headers: { "content-type": "text/plain" } }),
    );

    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(MAX_RESPONSE_BYTES + 4 * chunk.byteLength);
    expect(textOf(result)?.endsWith("[apibear] response truncated at 256000 characters")).toBe(true);
  });

  it("returns a raster image as MCP image content", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await normalizeResponse(
      new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("summarizes a binary body instead of decoding it as text", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x81]);
    const result = await normalizeResponse(
      new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }),
    );

    expect(textOf(result)).toBe("(binary response: application/pdf, 8 bytes; not shown)");
  });

  it("decodes an undeclared-but-valid UTF-8 body as text", async () => {
    const result = await normalizeResponse(
      new Response("plain diff text", {
        status: 200,
        headers: { "content-type": "application/vnd.example.diff" },
      }),
    );

    expect(textOf(result)).toBe("plain diff text");
  });

  it("includes Retry-After in the status line when present", async () => {
    const result = await normalizeResponse(
      new Response("slow down", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "30" },
      }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("HTTP 429 Too Many Requests (Retry-After: 30)\n\nslow down");
  });
});

describe("executeTool redirects", () => {
  /** A fetch stub that answers each URL from `routes`, recording every call. */
  function routedFetch(routes: Record<string, () => Response>) {
    return vi.fn<FetchLike>(async (input) => {
      const route = routes[input];
      if (route === undefined) {
        throw new Error(`unexpected request to ${input}`);
      }
      return route();
    });
  }

  const redirect = (status: number, location: string) => () =>
    new Response(null, { status, headers: { location } });
  const ok = () => () => new Response("done", { status: 200 });

  it("asks fetch not to follow redirects itself", async () => {
    const fetchImpl = routedFetch({ "https://api.example.com/things": ok() });

    await executeTool(makeTool(), {}, options({ fetchImpl }));

    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("keeps injected headers on a same-origin redirect", async () => {
    const fetchImpl = routedFetch({
      "https://api.example.com/things": redirect(302, "/v2/things"),
      "https://api.example.com/v2/things": ok(),
    });

    const result = await executeTool(
      makeTool(),
      {},
      options({ fetchImpl, cliHeaders: { "X-API-Key": "secret" } }),
    );

    expect(textOf(result)).toBe("done");
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({ "X-API-Key": "secret" });
  });

  it("drops injected and credential headers on a cross-origin redirect", async () => {
    const fetchImpl = routedFetch({
      "https://api.example.com/things": redirect(307, "https://cdn.example.net/blob"),
      "https://cdn.example.net/blob": ok(),
    });

    const result = await executeTool(
      makeTool(),
      {},
      options({
        fetchImpl,
        cliHeaders: { "X-API-Key": "secret", authorization: "Bearer t" },
      }),
    );

    expect(textOf(result)).toBe("done");
    const headers = fetchImpl.mock.calls[1]?.[1]?.headers ?? {};
    expect(headerKeys(headers, "x-api-key")).toEqual([]);
    expect(headerKeys(headers, "authorization")).toEqual([]);
    expect(headers).toMatchObject({ Accept: "application/json" });
  });

  it("turns a POST into a bodyless GET on 303", async () => {
    const fetchImpl = routedFetch({
      "https://api.example.com/things": redirect(303, "/things/1"),
      "https://api.example.com/things/1": ok(),
    });
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: true, contentType: "application/json", embedding: "merged" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    );

    await executeTool(tool, { name: "Rex" }, options({ fetchImpl }));

    const second = fetchImpl.mock.calls[1]?.[1];
    expect(second?.method).toBe("GET");
    expect(second?.body).toBeUndefined();
    expect(headerKeys(second?.headers ?? {}, "content-type")).toEqual([]);
  });

  it("keeps the method and body on 307", async () => {
    const fetchImpl = routedFetch({
      "https://api.example.com/things": redirect(307, "/things2"),
      "https://api.example.com/things2": ok(),
    });
    const tool = makeTool(
      {
        method: "post",
        requestBody: { required: true, contentType: "application/json", embedding: "merged" },
      },
      {
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    );

    await executeTool(tool, { name: "Rex" }, options({ fetchImpl }));

    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: '{"name":"Rex"}' });
  });

  it("gives up after too many redirects", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => redirect(302, "/things")());

    const result = await executeTool(makeTool(), {}, options({ fetchImpl }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`request failed: too many redirects (more than ${MAX_REDIRECTS})`);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("refuses a redirect to a non-http(s) scheme", async () => {
    const fetchImpl = routedFetch({
      "https://api.example.com/things": redirect(302, "file:///etc/passwd"),
    });

    const result = await executeTool(makeTool(), {}, options({ fetchImpl }));

    expect(textOf(result)).toBe("request failed: HTTP 302 redirect to unsupported scheme file:");
  });

  it("strips injected headers across origins with the real fetch", async () => {
    const seen: Array<string | undefined> = [];
    const target = createServer((request, response) => {
      seen.push(request.headers["x-api-key"] as string | undefined);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("landed");
    });
    const origin = createServer((request, response) => {
      seen.push(request.headers["x-api-key"] as string | undefined);
      response.writeHead(302, { location: `http://127.0.0.1:${port(target)}/landing` });
      response.end();
    });
    await Promise.all([listen(target), listen(origin)]);
    try {
      const result = await executeTool(
        makeTool({ baseUrl: `http://127.0.0.1:${port(origin)}` }),
        {},
        options({ cliHeaders: { "X-API-Key": "secret" } }),
      );

      expect(textOf(result)).toBe("landed");
      expect(seen).toEqual(["secret", undefined]);
    } finally {
      await Promise.all([close(target), close(origin)]);
    }
  });

  it("returns a 3xx without Location as-is", async () => {
    const fetchImpl = routedFetch({
      "https://api.example.com/things": () => new Response("moved?", { status: 302 }),
    });

    const result = await executeTool(makeTool(), {}, options({ fetchImpl }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("HTTP 302");
  });
});

describe("executeTool cancellation", () => {
  it("reports a client cancellation distinctly from a timeout", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchLike>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort();
        }),
    );

    const result = await executeTool(
      makeTool(),
      {},
      options({ fetchImpl, signal: controller.signal, timeoutMs: 10_000 }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("request failed: cancelled by the client");
  });
});
