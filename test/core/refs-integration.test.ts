import { describe, expect, it } from "vitest";

import refsJson from "./fixtures/refs.json";
import { toMcpTool } from "../../src/core/mcp.js";
import { parseOpenApiToTools } from "../../src/core/parse.js";
import { OpenApiParseError, type ParsedTool, type ParseResult } from "../../src/core/types.js";

/** Mutable view of the refs fixture used by the inline-built cycle variant. */
interface RefsDocument {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
}

/**
 * Load a fresh, mutable copy of the refs fixture.
 *
 * Structured cloning keeps the imported JSON module (and its inferred literal
 * types) untouched between tests.
 */
function loadRefs(): Record<string, unknown> {
  return structuredClone(refsJson) as Record<string, unknown>;
}

/**
 * Load the refs fixture with mutable `paths`/`components` accessors.
 */
function loadRefsDocument(): RefsDocument {
  return structuredClone(refsJson) as unknown as RefsDocument;
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
 * Parse a document expected to fail and return the thrown error.
 *
 * @param doc - Input expected to throw.
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

describe("parseOpenApiToTools — refs fixture", () => {
  it("discovers the resolvable operations and reports the two broken ones", () => {
    const result = parseOpenApiToTools(loadRefs());

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "listPetsByRef",
      "createPetFromRefChain",
      "bulkCreatePets",
      "showPetByIdViaParamRef",
    ]);
    expect(result.api).toEqual({
      title: "Refs API",
      version: "2.1.0",
      baseUrl: "https://refs.example.com/v1",
    });

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unresolved-ref",
      "unresolved-ref",
    ]);
    // Every tool resolves the root server.
    expect(result.tools.map((tool) => tool.metadata.baseUrl)).toEqual([
      "https://refs.example.com/v1",
      "https://refs.example.com/v1",
      "https://refs.example.com/v1",
      "https://refs.example.com/v1",
    ]);
  });

  it("resolves parameters via #/components/parameters and escaped/encoded schema pointers", () => {
    const tool = findTool(parseOpenApiToTools(loadRefs()), "listPetsByRef");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description: "Maximum number of items to return",
        },
        // "#/components/schemas/tag~0filter" -> key "tag~filter"
        tag: { type: "string", maxLength: 40, description: "Filter by tag" },
        // "#/components/schemas/Pet~1Status" -> key "Pet/Status"
        status: { type: "string", enum: ["available", "pending", "sold"] },
        // "#/components/schemas/pet%20id" -> key "pet id"
        q: { type: "string", pattern: "^[0-9]+$" },
        // DepthAlias -> DepthValue: a two-hop schema chain behind a parameter ref.
        depth: { type: "integer", minimum: 0, maximum: 5 },
      },
      required: ["q"],
      additionalProperties: false,
    });
    expect(tool.metadata.parameters).toEqual([
      { name: "limit", in: "query", required: false },
      { name: "tag", in: "query", required: false },
      { name: "status", in: "query", required: false },
      { name: "q", in: "query", required: true },
      { name: "depth", in: "query", required: false },
    ]);
    expect(tool.metadata).toMatchObject({
      operationId: "listPetsByRef",
      method: "get",
      pathTemplate: "/pets",
      requestBody: null,
      deprecated: false,
    });
  });

  it("follows requestBody → requestBodies → schema → schema chains", () => {
    const tool = findTool(parseOpenApiToTools(loadRefs()), "createPetFromRefChain");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        tag: { type: "string", maxLength: 40 },
        status: { type: "string", enum: ["available", "pending", "sold"] },
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

  it("resolves ref chains nested inside array items and nests the non-object body", () => {
    const tool = findTool(parseOpenApiToTools(loadRefs()), "bulkCreatePets");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        body: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              tag: { type: "string", maxLength: 40 },
              status: { type: "string", enum: ["available", "pending", "sold"] },
            },
          },
        },
      },
      required: ["body"],
      additionalProperties: false,
    });
    expect(tool.metadata.requestBody).toEqual({
      required: true,
      contentType: "application/json",
      embedding: "nested",
      bodyKey: "body",
    });
  });

  it("resolves a path-item parameter declared as a $ref", () => {
    const tool = findTool(parseOpenApiToTools(loadRefs()), "showPetByIdViaParamRef");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        petId: { type: "string", description: "Pet identifier" },
      },
      required: ["petId"],
      additionalProperties: false,
    });
    expect(tool.metadata.parameters).toEqual([{ name: "petId", in: "path", required: true }]);
  });

  it("skips an operation whose parameter points at a missing internal pointer", () => {
    const result = parseOpenApiToTools(loadRefs());

    expect(result.tools.map((tool) => tool.metadata.operationId)).not.toContain(
      "missingPointerParam",
    );
    const warning = result.warnings.find((candidate) =>
      candidate.message.includes("missingPointerParam") ||
      candidate.pointer === "#/components/parameters/DoesNotExist",
    );
    expect(warning?.code).toBe("unresolved-ref");
    expect(warning?.pointer).toBe("#/components/parameters/DoesNotExist");
    expect(warning?.message).toContain('"GET /broken"');
    expect(warning?.message).toContain("#/components/parameters/DoesNotExist");
  });

  it("skips an operation whose request body contains an external https ref", () => {
    const result = parseOpenApiToTools(loadRefs());

    expect(result.tools.map((tool) => tool.metadata.operationId)).not.toContain(
      "externalSchemaRef",
    );
    const warning = result.warnings.find((candidate) =>
      candidate.message.includes("https://example.com/schemas/ExternalPet.json#/Pet"),
    );
    expect(warning?.code).toBe("unresolved-ref");
    expect(warning?.pointer).toBe("#/paths/~1external/post");
    expect(warning?.message).toContain('"POST /external"');
  });

  it("does not fail on a cycle that is never reached from an operation", () => {
    // The fixture defines a recursive TreeNode schema that no operation uses.
    const result = parseOpenApiToTools(loadRefs());

    expect(result.tools).toHaveLength(4);
    expect(result.warnings.some((warning) => warning.code === "unresolved-ref")).toBe(true);
  });

  it("throws ref-cycle when a recursive schema is on the critical path", () => {
    const doc = loadRefsDocument();
    doc.paths["/tree"] = {
      post: {
        operationId: "createTree",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TreeNode" },
            },
          },
        },
        responses: { 201: { description: "Created" } },
      },
    };

    const error = captureParseError(doc);
    expect(error.code).toBe("ref-cycle");
    expect(error.pointer).toBe("#/components/schemas/TreeNode");
    expect(error.message).toContain("#/components/schemas/TreeNode");
  });

  it("never mutates the refs document", () => {
    const fixture = loadRefs();
    const snapshot = structuredClone(fixture);
    deepFreeze(fixture);

    const result = parseOpenApiToTools(fixture);

    expect(result.tools).toHaveLength(4);
    expect(fixture).toEqual(snapshot);
  });

  it("projects every refs tool onto a metadata-free wire shape", () => {
    for (const tool of parseOpenApiToTools(loadRefs()).tools) {
      const wire = toMcpTool(tool);
      expect(wire.name).toBe(tool.name);
      expect(wire.inputSchema).toEqual(tool.inputSchema);
      expect(wire).not.toHaveProperty("metadata");
    }
  });
});
