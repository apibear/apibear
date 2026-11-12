import { describe, expect, it } from "vitest";

import petstoreJson from "./fixtures/petstore.json";
import * as publicApi from "../../src/core/index.js";
import { toMcpTool } from "../../src/core/mcp.js";
import { parseOpenApiToTools } from "../../src/core/parse.js";
import { OpenApiParseError, type ParsedTool, type ParseResult } from "../../src/core/types.js";

/**
 * Load a fresh, mutable copy of the petstore fixture.
 *
 * Structured cloning keeps the imported JSON module (and its inferred literal
 * types) untouched between tests.
 */
function loadPetstore(): Record<string, unknown> {
  return structuredClone(petstoreJson) as Record<string, unknown>;
}

/**
 * Build a minimal valid OpenAPI document around the supplied paths.
 *
 * @param paths - Path map for the document.
 * @param extra - Additional root fields (e.g. `servers`).
 */
function makeDoc(
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title: "Test API", version: "1.0.0" },
    ...extra,
    paths,
  };
}

/**
 * Recursively freeze a value so accidental mutation throws in strict mode.
 *
 * @param value - Value to freeze in place.
 * @returns The same value, fully frozen.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Find a tool by name, failing the test when it is absent.
 *
 * @param result - Parse result to search.
 * @param name - Expected tool name.
 */
function findTool(result: ParseResult, name: string): ParsedTool {
  const tool = result.tools.find((candidate) => candidate.name === name);
  expect(tool, `expected a tool named "${name}"`).toBeDefined();
  return tool as ParsedTool;
}

/**
 * Return warning codes in result order.
 *
 * @param result - Parse result to inspect.
 */
function warningCodes(result: ParseResult): string[] {
  return result.warnings.map((warning) => warning.code);
}

/**
 * Parse a document expected to fail and return the thrown error.
 *
 * @param doc - Malformed input.
 */
function captureParseError(doc: unknown): OpenApiParseError {
  try {
    parseOpenApiToTools(doc);
  } catch (error) {
    expect(error).toBeInstanceOf(OpenApiParseError);
    return error as OpenApiParseError;
  }
  throw new Error("Expected parseOpenApiToTools to throw.");
}

describe("parseOpenApiToTools — petstore fixture", () => {
  it("discovers tools in path/method order with no warnings", () => {
    const result = parseOpenApiToTools(loadPetstore());

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "listPets",
      "createPet",
      "showPetById",
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.api).toEqual({
      title: "Swagger Petstore",
      version: "1.0.0",
      baseUrl: "https://petstore.example.com/api/v3",
    });
  });

  it("matches the golden expectation for showPetById", () => {
    const tool = findTool(parseOpenApiToTools(loadPetstore()), "showPetById");
    const { metadata, ...wire } = tool;

    expect(wire).toEqual({
      name: "showPetById",
      description: "Info for a specific pet",
      inputSchema: {
        type: "object",
        properties: { petId: { type: "string" } },
        required: ["petId"],
        additionalProperties: false,
      },
    });
    expect(metadata).toEqual({
      operationId: "showPetById",
      method: "get",
      pathTemplate: "/pets/{petId}",
      baseUrl: "https://petstore.example.com/api/v3",
      parameters: [{ name: "petId", in: "path", required: true }],
      requestBody: null,
      securityHeaderNames: [],
      deprecated: false,
    });
  });

  it("merges the createPet $ref request body into the input schema", () => {
    const tool = findTool(parseOpenApiToTools(loadPetstore()), "createPet");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        tag: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    });
    expect(tool.metadata.requestBody).toEqual({
      required: true,
      contentType: "application/json",
      embedding: "merged",
    });
    expect(tool.metadata.parameters).toEqual([]);
  });

  it("passes through array query schemas and integer minimums", () => {
    const tool = findTool(parseOpenApiToTools(loadPetstore()), "listPets");

    expect(tool.inputSchema.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
      description: "Tags to filter by",
    });
    expect(tool.inputSchema.properties.limit).toEqual({
      type: "integer",
      minimum: 1,
      description: "Maximum number of items to return",
    });
  });

  it("excludes deprecated operations by default and includes them on request", () => {
    const byDefault = parseOpenApiToTools(loadPetstore());
    expect(byDefault.tools.map((tool) => tool.name)).not.toContain("delete_pets_petId");

    const withDeprecated = parseOpenApiToTools(loadPetstore(), {
      filter: { includeDeprecated: true },
    });
    const tool = findTool(withDeprecated, "delete_pets_petId");

    expect(tool.description).toBe("Delete a pet (deprecated)");
    expect(tool.metadata).toMatchObject({
      operationId: "delete_pets_petId",
      method: "delete",
      pathTemplate: "/pets/{petId}",
      deprecated: true,
      requestBody: null,
    });
  });
});

describe("parseOpenApiToTools — filters", () => {
  it("filters by original operationId", () => {
    const result = parseOpenApiToTools(loadPetstore(), {
      filter: { operationIds: ["createPet"] },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["createPet"]);
    expect(result.warnings).toEqual([]);
  });

  it("filters by generated fallback id", () => {
    const result = parseOpenApiToTools(loadPetstore(), {
      filter: { operationIds: ["get_pets_petId"] },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["showPetById"]);
  });

  it("warns about unknown filter ids instead of throwing", () => {
    const result = parseOpenApiToTools(loadPetstore(), {
      filter: { operationIds: ["notAnOperation", "showPetById"] },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["showPetById"]);
    const unknown = result.warnings.filter((warning) => warning.code === "unknown-filter-id");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain("notAnOperation");
  });

  it("honors filter.methods and aggregates skipped method warnings", () => {
    const result = parseOpenApiToTools(loadPetstore(), {
      filter: { methods: ["post"] },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["createPet"]);

    const skipped = result.warnings.filter((warning) => warning.code === "skipped-unsupported");
    const getWarning = skipped.find((warning) => warning.message.includes('"get"'));
    expect(getWarning?.message).toContain("2 operation(s) skipped");
  });

  it("emits one skipped-unsupported warning per unsupported method type", () => {
    const doc = makeDoc({
      "/a": { head: { operationId: "aHead", responses: {} } },
      "/b": { head: { operationId: "bHead", responses: {} } },
      "/c": { get: { operationId: "cGet", responses: {} } },
    });

    const result = parseOpenApiToTools(doc);

    expect(result.tools.map((tool) => tool.name)).toEqual(["cGet"]);
    const skipped = result.warnings.filter((warning) => warning.code === "skipped-unsupported");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.message).toContain('"head"');
    expect(skipped[0]?.message).toContain("2 operation(s) skipped");
  });
});

describe("parseOpenApiToTools — naming", () => {
  it("dedupes case-insensitively across operations", () => {
    const doc = makeDoc({
      "/a": { get: { operationId: "dup", responses: {} } },
      "/b": { post: { operationId: "dup", responses: {} } },
      "/c": { get: { operationId: "getPets", responses: {} } },
      "/d": { get: { operationId: "getpets", responses: {} } },
    });

    const result = parseOpenApiToTools(doc);

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "dup",
      "dup_2",
      "getPets",
      "getpets_2",
    ]);
    expect(result.tools.map((tool) => tool.metadata.operationId)).toEqual([
      "dup",
      "dup",
      "getPets",
      "getpets",
    ]);
  });

  it("derives names from the method and path when operationId is missing", () => {
    const doc = makeDoc({
      "/pets/{petId}": {
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
        delete: { responses: {} },
      },
    });

    const [tool] = parseOpenApiToTools(doc).tools;

    expect(tool?.name).toBe("delete_pets_petId");
    expect(tool?.metadata.operationId).toBe("delete_pets_petId");
  });
});

describe("parseOpenApiToTools — validation and empty documents", () => {
  it("throws invalid-document for malformed input", () => {
    const invalidInputs: unknown[] = [
      null,
      42,
      "openapi",
      [],
      {},
      { openapi: 3, paths: {} },
      { openapi: "3.0.3", paths: [] },
    ];

    for (const input of invalidInputs) {
      expect(captureParseError(input).code).toBe("invalid-document");
    }
  });

  it("accepts missing or empty paths and returns no tools or warnings", () => {
    const missing = parseOpenApiToTools({
      openapi: "3.0.0",
      info: { title: "Empty", version: "2.0.0" },
    });
    expect(missing).toEqual({
      tools: [],
      api: { title: "Empty", version: "2.0.0", baseUrl: null },
      warnings: [],
    });

    const empty = parseOpenApiToTools({
      openapi: "3.0.0",
      servers: [{ url: "https://api.example.com" }],
      paths: {},
    });
    expect(empty.tools).toEqual([]);
    expect(empty.warnings).toEqual([]);
    expect(empty.api.baseUrl).toBe("https://api.example.com");
  });
});

describe("parseOpenApiToTools — $ref handling", () => {
  it("skips operations whose parameters or request bodies contain external refs", () => {
    const doc = makeDoc({
      "/pets": {
        get: {
          operationId: "externalParam",
          parameters: [{ $ref: "https://example.com/shared.json#/Limit" }],
          responses: {},
        },
      },
      "/pets/{petId}": {
        put: {
          operationId: "externalBody",
          parameters: [
            { name: "petId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { friend: { $ref: "https://example.com/Pet.json" } },
                },
              },
            },
          },
          responses: {},
        },
      },
    });

    const result = parseOpenApiToTools(doc);

    expect(result.tools).toEqual([]);
    const unresolved = result.warnings.filter((warning) => warning.code === "unresolved-ref");
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]?.message).toContain("https://example.com/shared.json");
    expect(unresolved[0]?.pointer).toBe("#/paths/~1pets/get");
    expect(unresolved[1]?.message).toContain("https://example.com/Pet.json");
    expect(unresolved[1]?.pointer).toBe("#/paths/~1pets~1{petId}/put");
  });

  it("skips operations with an unresolvable internal ref and reports its pointer", () => {
    const doc = makeDoc({
      "/pets": {
        get: {
          operationId: "brokenParam",
          parameters: [{ $ref: "#/components/parameters/Missing" }],
          responses: {},
        },
      },
    });

    const result = parseOpenApiToTools(doc);

    expect(result.tools).toEqual([]);
    const warning = result.warnings.find((candidate) => candidate.code === "unresolved-ref");
    expect(warning?.pointer).toBe("#/components/parameters/Missing");
  });

  it("propagates ref-cycle errors from critical-path resolution", () => {
    const doc = makeDoc(
      {
        "/nodes": {
          post: {
            operationId: "createNode",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Node" },
                },
              },
            },
            responses: {},
          },
        },
      },
      {
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: { next: { $ref: "#/components/schemas/Node" } },
            },
          },
        },
      },
    );

    const error = captureParseError(doc);
    expect(error.code).toBe("ref-cycle");
  });
});

describe("parseOpenApiToTools — servers", () => {
  it("treats a relative server URL as unresolved and warns once", () => {
    const result = parseOpenApiToTools(
      makeDoc(
        {
          "/a": { get: { operationId: "a", responses: {} } },
          "/b": { get: { operationId: "b", responses: {} } },
        },
        { servers: [{ url: "/api/v3" }] },
      ),
    );

    expect(result.api.baseUrl).toBeNull();
    expect(result.tools.map((tool) => tool.metadata.baseUrl)).toEqual([null, null]);
    const relative = result.warnings.filter(
      (warning) => warning.code === "relative-server-url",
    );
    expect(relative).toHaveLength(1);
  });

  it("warns once at the document level when no server is defined", () => {
    const result = parseOpenApiToTools(
      makeDoc({
        "/a": { get: { operationId: "a", responses: {} } },
        "/b": { get: { operationId: "b", responses: {} } },
      }),
    );

    expect(result.api.baseUrl).toBeNull();
    expect(result.tools.map((tool) => tool.metadata.baseUrl)).toEqual([null, null]);
    const missing = result.warnings.filter((warning) => warning.code === "no-server-url");
    expect(missing).toHaveLength(1);
  });

  it("substitutes server variables from default and the first enum entry", () => {
    const result = parseOpenApiToTools(
      makeDoc(
        { "/a": { get: { operationId: "a", responses: {} } } },
        {
          servers: [
            {
              url: "https://{host}.example.com/{apiVersion}",
              variables: {
                host: { default: "petstore" },
                apiVersion: { enum: ["v3", "v2"] },
              },
            },
          ],
        },
      ),
    );

    expect(result.api.baseUrl).toBe("https://petstore.example.com/v3");
    expect(result.tools[0]?.metadata.baseUrl).toBe("https://petstore.example.com/v3");
    expect(result.warnings).toEqual([]);
  });

  it("prefers operation servers over path-item and document servers", () => {
    const result = parseOpenApiToTools(
      makeDoc(
        {
          "/things": {
            servers: [{ url: "https://path.example.com" }],
            get: {
              operationId: "withOperationServer",
              servers: [{ url: "https://operation.example.com" }],
              responses: {},
            },
            post: { operationId: "withPathServer", responses: {} },
          },
        },
        { servers: [{ url: "https://root.example.com" }] },
      ),
    );

    expect(result.api.baseUrl).toBe("https://root.example.com");
    expect(findTool(result, "withOperationServer").metadata.baseUrl).toBe(
      "https://operation.example.com",
    );
    expect(findTool(result, "withPathServer").metadata.baseUrl).toBe(
      "https://path.example.com",
    );
  });

  it("warns when a server variable has neither default nor enum", () => {
    const result = parseOpenApiToTools(
      makeDoc(
        { "/a": { get: { operationId: "a", responses: {} } } },
        {
          servers: [
            {
              url: "https://{host}.example.com",
              variables: { host: {} },
            },
          ],
        },
      ),
    );

    expect(result.api.baseUrl).toBeNull();
    expect(result.tools[0]?.metadata.baseUrl).toBeNull();
    const warning = result.warnings.find((candidate) => candidate.code === "no-server-url");
    expect(warning?.message).toContain('"host"');
  });
});

describe("parseOpenApiToTools — immutability", () => {
  it("never mutates the input document", () => {
    const fixture = loadPetstore();
    const snapshot = structuredClone(fixture);
    deepFreeze(fixture);

    const result = parseOpenApiToTools(fixture);

    expect(result.tools).toHaveLength(3);
    expect(fixture).toEqual(snapshot);
  });
});

describe("toMcpTool", () => {
  it("projects a parsed tool onto exactly name, description, inputSchema", () => {
    const tool = findTool(parseOpenApiToTools(loadPetstore()), "showPetById");
    const wire = toMcpTool(tool);

    expect(wire).toEqual({
      name: "showPetById",
      description: "Info for a specific pet",
      inputSchema: tool.inputSchema,
    });
    expect(wire).not.toHaveProperty("metadata");
    expect(wire).not.toBe(tool);
  });

  it("omits the description key when the tool has none", () => {
    const tool: ParsedTool = {
      name: "empty",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      metadata: {
        operationId: "empty",
        method: "get",
        pathTemplate: "/empty",
        baseUrl: null,
        parameters: [],
        requestBody: null,
        securityHeaderNames: [],
        deprecated: false,
      },
    };

    const wire = toMcpTool(tool);
    expect(Object.keys(wire)).toEqual(["name", "inputSchema"]);
    expect(wire).not.toHaveProperty("description");
  });
});

describe("public exports", () => {
  it("exposes only the public runtime contract", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "OpenApiParseError",
      "parseOpenApiToTools",
      "toMcpTool",
    ]);
    expect(publicApi.parseOpenApiToTools).toBe(parseOpenApiToTools);
    expect(publicApi.OpenApiParseError).toBe(OpenApiParseError);
  });
});

describe("warning codes", () => {
  it("only uses codes from the frozen union", () => {
    const allowed = new Set([
      "unknown-filter-id",
      "unresolved-ref",
      "skipped-unsupported",
      "no-server-url",
      "relative-server-url",
    ]);
    const result = parseOpenApiToTools(loadPetstore(), {
      filter: { operationIds: ["unknown"], methods: ["get"] },
    });

    for (const code of warningCodes(result)) {
      expect(allowed.has(code)).toBe(true);
    }
  });
});
