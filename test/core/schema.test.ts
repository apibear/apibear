import { describe, expect, it } from "vitest";

import type { Parameter } from "../../src/core/params.js";
import { buildInputSchema, schemaForParameterLocations } from "../../src/core/schema.js";

/**
 * Narrow an unknown value to a plain object for the test helpers.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an internal JSON pointer such as `#/components/schemas/Pet`.
 */
function pointerGet(doc: Record<string, unknown>, ref: string): unknown {
  let current: unknown = doc;
  for (const token of ref.slice(2).split("/")) {
    const key = decodeURIComponent(token).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * Build a deep internal-`$ref` resolver over a literal document, mirroring the
 * `resolveDeep` contract used in production.
 */
function createResolver(doc: Record<string, unknown>): (value: unknown) => unknown {
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => resolve(item));
    }
    if (!isRecord(value)) {
      return value;
    }
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
      return resolve(pointerGet(doc, value.$ref));
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = resolve(item);
    }
    return output;
  };
  return resolve;
}

const identity = (value: unknown): unknown => value;

/**
 * Create a parameter with sensible defaults for tests.
 */
function parameter(overrides: Partial<Parameter> & Pick<Parameter, "name" | "in">): Parameter {
  return {
    required: false,
    schema: { type: "string" },
    ...overrides,
  };
}

describe("buildInputSchema", () => {
  it("returns the empty object schema when there are no params and no body", () => {
    const result = buildInputSchema([], null, identity);

    expect(result).toEqual({
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      requestBodyPlan: null,
    });
  });

  it("copies parameter schemas verbatim, including array-valued query schemas", () => {
    const tags = {
      type: "array",
      items: { type: "string" },
      style: "form",
      explode: true,
    };
    const result = buildInputSchema(
      [
        parameter({ name: "tags", in: "query", schema: tags }),
        parameter({ name: "limit", in: "query", schema: { type: "integer", minimum: 1, default: 10 } }),
      ],
      undefined,
      identity,
    );

    expect(result.inputSchema.properties).toEqual({
      tags: {
        type: "array",
        items: { type: "string" },
        style: "form",
        explode: true,
      },
      limit: { type: "integer", minimum: 1, default: 10 },
    });
    expect(result.inputSchema.required).toEqual([]);
    expect(result.inputSchema.additionalProperties).toBe(false);
  });

  it("adds the parameter description only when the schema lacks one", () => {
    const result = buildInputSchema(
      [
        parameter({ name: "q", in: "query", description: "Search terms" }),
        parameter({
          name: "sort",
          in: "query",
          description: "Parameter description",
          schema: { type: "string", description: "Schema description" },
        }),
      ],
      null,
      identity,
    );

    expect(result.inputSchema.properties.q).toEqual({ type: "string", description: "Search terms" });
    expect(result.inputSchema.properties.sort).toEqual({
      type: "string",
      description: "Schema description",
    });
  });

  it("always requires path parameters, regardless of the parameter flag", () => {
    const result = buildInputSchema(
      [
        parameter({ name: "petId", in: "path", required: false }),
        parameter({ name: "q", in: "query", required: true }),
        parameter({ name: "x-trace", in: "header", required: false }),
      ],
      null,
      identity,
    );

    expect(result.inputSchema.required).toEqual(["petId", "q"]);
  });

  it("merges an object body when no property name collides with a parameter", () => {
    const requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              tag: { type: "string" },
            },
          },
        },
      },
    };

    const result = buildInputSchema(
      [parameter({ name: "limit", in: "query", schema: { type: "integer" }, description: "Max results" })],
      requestBody,
      identity,
    );

    expect(result.inputSchema.properties).toEqual({
      limit: { type: "integer", description: "Max results" },
      name: { type: "string" },
      tag: { type: "string" },
    });
    expect(result.inputSchema.required).toEqual(["name"]);
    expect(result.requestBodyPlan).toEqual({
      required: true,
      contentType: "application/json",
      embedding: "merged",
    });
    expect(result.requestBodyPlan).not.toHaveProperty("bodyKey");
  });

  it("falls back to nested embedding when a body property collides with a parameter name", () => {
    const bodySchema = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        tag: { type: "string" },
      },
    };
    const requestBody = {
      required: false,
      content: { "application/json": { schema: bodySchema } },
    };

    const result = buildInputSchema(
      [parameter({ name: "name", in: "query", required: true })],
      requestBody,
      identity,
    );

    expect(result.inputSchema.properties.name).toEqual({ type: "string" });
    expect(result.inputSchema.properties.body).toEqual(bodySchema);
    expect(result.inputSchema.required).toEqual(["name"]);
    expect(result.requestBodyPlan).toEqual({
      required: false,
      contentType: "application/json",
      embedding: "nested",
      bodyKey: "body",
    });
  });

  it("nests non-object body schemas and requires body only when the request body is required", () => {
    const bodySchema = { type: "array", items: { type: "string" } };
    const optional = buildInputSchema(
      [parameter({ name: "ids", in: "query" })],
      { content: { "application/json": { schema: bodySchema } } },
      identity,
    );
    const required = buildInputSchema(
      [parameter({ name: "ids", in: "query" })],
      {
        required: true,
        content: { "application/json": { schema: { type: "string" } } },
      },
      identity,
    );

    expect(optional.inputSchema.properties.body).toEqual(bodySchema);
    expect(optional.inputSchema.required).toEqual([]);
    expect(optional.requestBodyPlan).toEqual({
      required: false,
      contentType: "application/json",
      embedding: "nested",
      bodyKey: "body",
    });
    expect(required.inputSchema.required).toEqual(["body"]);
  });

  it("resolves a $ref-requestBody and its $ref schema", () => {
    const doc = {
      components: {
        requestBodies: {
          PetBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
        schemas: {
          Pet: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              tag: { type: "string" },
            },
          },
        },
      },
    };

    const result = buildInputSchema(
      [],
      { $ref: "#/components/requestBodies/PetBody" },
      createResolver(doc),
    );

    expect(result.inputSchema.properties).toEqual({
      name: { type: "string" },
      tag: { type: "string" },
    });
    expect(result.inputSchema.required).toEqual(["name"]);
    expect(result.requestBodyPlan).toEqual({
      required: true,
      contentType: "application/json",
      embedding: "merged",
    });
  });

  it("selects application/x-www-form-urlencoded when JSON is absent", () => {
    const result = buildInputSchema(
      [],
      {
        content: {
          "application/x-www-form-urlencoded": {
            schema: { type: "object", properties: { field: { type: "string" } } },
          },
        },
      },
      identity,
    );

    expect(result.requestBodyPlan).toEqual({
      required: false,
      contentType: "application/x-www-form-urlencoded",
      embedding: "merged",
    });
    expect(result.inputSchema.properties.field).toEqual({ type: "string" });
  });

  it("prefers application/json over form encoding regardless of declaration order", () => {
    const result = buildInputSchema(
      [],
      {
        content: {
          "application/x-www-form-urlencoded": {
            schema: { type: "object", properties: { form: { type: "string" } } },
          },
          "application/json": {
            schema: { type: "object", properties: { json: { type: "string" } } },
          },
        },
      },
      identity,
    );

    expect(result.requestBodyPlan?.contentType).toBe("application/json");
    expect(result.inputSchema.properties).toEqual({ json: { type: "string" } });
  });

  it("records the first listed content type when neither JSON nor form is available", () => {
    const result = buildInputSchema(
      [],
      {
        content: {
          "multipart/form-data": {
            schema: { type: "object", properties: { file: { type: "string" } } },
          },
        },
      },
      identity,
    );

    expect(result.requestBodyPlan).toEqual({
      required: false,
      contentType: "multipart/form-data",
      embedding: "merged",
    });
    expect(result.inputSchema.properties.file).toEqual({ type: "string" });
  });

  it("returns a null plan when the request body has no content", () => {
    expect(buildInputSchema([], {}, identity).requestBodyPlan).toBeNull();
    expect(buildInputSchema([], { content: {} }, identity).requestBodyPlan).toBeNull();
    expect(buildInputSchema([], { content: null }, identity).requestBodyPlan).toBeNull();
  });

  it("merges body required names without duplicating parameter required names", () => {
    const result = buildInputSchema(
      [parameter({ name: "id", in: "query", required: true })],
      {
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["id", "name", "name"],
              properties: { name: { type: "string" } },
            },
          },
        },
      },
      identity,
    );

    expect(result.inputSchema.required).toEqual(["id", "name"]);
  });

  it("never mutates parameters, request bodies, or their schemas", () => {
    const params: Parameter[] = [
      {
        name: "tags",
        in: "query",
        required: false,
        description: "Filter by tags",
        schema: { type: "array", items: { type: "string" } },
      },
    ];
    const requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" }, tag: { type: "string" } },
          },
        },
      },
    };
    const paramsSnapshot = JSON.parse(JSON.stringify(params));
    const bodySnapshot = JSON.parse(JSON.stringify(requestBody));

    const result = buildInputSchema(params, requestBody, identity);
    const property = result.inputSchema.properties.tags;
    expect(property).not.toBe(params[0]?.schema);
    property!.type = "mutated";

    expect(params).toEqual(paramsSnapshot);
    expect(requestBody).toEqual(bodySnapshot);
  });
});

describe("schemaForParameterLocations", () => {
  it("projects parameters onto name/in/required and forces path required", () => {
    const params: Parameter[] = [
      parameter({ name: "petId", in: "path", required: false }),
      parameter({ name: "q", in: "query", required: true }),
      parameter({ name: "x-api-version", in: "header", required: false }),
    ];

    expect(schemaForParameterLocations(params)).toEqual([
      { name: "petId", in: "path", required: true },
      { name: "q", in: "query", required: true },
      { name: "x-api-version", in: "header", required: false },
    ]);
  });
});
