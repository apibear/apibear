import { describe, expect, it } from "vitest";

import { collectParameters, type Parameter } from "../../src/core/params.js";

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

describe("collectParameters", () => {
  it("merges path-item and operation parameters with operation-level overrides first-seen", () => {
    const pathItem = {
      parameters: [
        { name: "petId", in: "path", required: true, schema: { type: "string" } },
        { name: "verbose", in: "query", required: false, schema: { type: "boolean" } },
      ],
    };
    const operation = {
      parameters: [
        {
          name: "petId",
          in: "path",
          required: true,
          description: "Overridden",
          schema: { type: "integer", minimum: 1 },
        },
        { name: "tags", in: "query", required: false, schema: { type: "array", items: { type: "string" } } },
      ],
    };

    const result = collectParameters(pathItem, operation, "/pets/{petId}", identity);

    expect(result.warnings).toEqual([]);
    expect(result.parameters.map((parameter) => parameter.name)).toEqual(["petId", "verbose", "tags"]);
    expect(result.parameters[0]).toEqual({
      name: "petId",
      in: "path",
      required: true,
      schema: { type: "integer", minimum: 1 },
      description: "Overridden",
    });
  });

  it("keeps distinct path-item and operation parameters without duplicating overrides", () => {
    const pathItem = {
      parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }],
      // A header with the same name but a different location is a distinct parameter.
    };
    const operation = {
      parameters: [
        { name: "q", in: "query", required: true, schema: { type: "integer" } },
        { name: "q", in: "header", required: false, schema: { type: "string" } },
      ],
    };

    const result = collectParameters(pathItem, operation, "/search", identity);

    expect(result.parameters).toEqual([
      { name: "q", in: "query", required: true, schema: { type: "integer" } },
      { name: "q", in: "header", required: false, schema: { type: "string" } },
    ]);
  });

  it("drops cookie parameters and warns, keeping the rest of the operation", () => {
    const pathItem = {
      parameters: [
        { name: "session", in: "cookie", schema: { type: "string" } },
        { name: "q", in: "query", required: true, schema: { type: "string" } },
      ],
    };

    const result = collectParameters(pathItem, {}, "/search", identity);

    expect(result.parameters.map((parameter) => parameter.name)).toEqual(["q"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: "skipped-unsupported" });
    expect(result.warnings[0]?.message).toContain("session");
  });

  it("drops parameters with unknown locations and warns with the parameter name", () => {
    const result = collectParameters(
      {
        parameters: [
          { name: "formField", in: "formData", schema: { type: "string" } },
          { name: "q", in: "query", required: false, schema: { type: "string" } },
        ],
      },
      undefined,
      "/search",
      identity,
    );

    expect(result.parameters.map((parameter) => parameter.name)).toEqual(["q"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: "skipped-unsupported" });
    expect(result.warnings[0]?.message).toContain("formField");
  });

  it("gives schemaless (content-style) parameters a string schema", () => {
    const result = collectParameters(
      {
        parameters: [
          {
            name: "filter",
            in: "query",
            required: false,
            content: { "application/json": { schema: { type: "object" } } },
          },
        ],
      },
      {},
      "/search",
      identity,
    );

    expect(result.parameters[0]?.schema).toEqual({ type: "string" });
  });

  it("forces path parameters to required even when the document says otherwise", () => {
    const result = collectParameters(
      { parameters: [{ name: "id", in: "path", required: false, schema: { type: "integer" } }] },
      {},
      "/things/{id}",
      identity,
    );

    expect(result.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer" } },
    ]);
  });

  it("synthesizes required string path parameters for undeclared template variables", () => {
    const result = collectParameters(
      {
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
          { name: "expand", in: "query", required: false, schema: { type: "string" } },
        ],
      },
      {},
      "/pets/{petId}/owners/{ownerId}",
      identity,
    );

    expect(result.parameters.map((parameter) => parameter.name)).toEqual(["petId", "expand", "ownerId"]);
    expect(result.parameters[2]).toEqual({
      name: "ownerId",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  });

  it("does not synthesize parameters already declared at path level", () => {
    const result = collectParameters(
      { parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }] },
      {},
      "/pets/{petId}",
      identity,
    );

    expect(result.parameters).toHaveLength(1);
  });

  it("resolves $ref parameters through the schema resolver", () => {
    const doc = {
      components: {
        parameters: {
          PetId: { name: "petId", in: "path", required: true, schema: { type: "string" } },
        },
      },
    };

    const result = collectParameters(
      { parameters: [{ $ref: "#/components/parameters/PetId" }] },
      {},
      "/pets/{petId}",
      createResolver(doc),
    );

    expect(result.parameters).toEqual([
      { name: "petId", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("resolves $ref schemas inside parameters", () => {
    const doc = {
      components: { schemas: { PetId: { type: "string", pattern: "^[0-9]+$" } } },
    };

    const result = collectParameters(
      {
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { $ref: "#/components/schemas/PetId" },
          },
        ],
      },
      {},
      "/pets/{petId}",
      createResolver(doc),
    );

    expect(result.parameters[0]?.schema).toEqual({ type: "string", pattern: "^[0-9]+$" });
  });

  it("omits description when the declaration has none", () => {
    const result = collectParameters(
      { parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }] },
      {},
      "/search",
      identity,
    );

    expect(result.parameters[0]).not.toHaveProperty("description");
  });

  it("never mutates pathItem, operation, or their schemas", () => {
    const pathItem = {
      parameters: [
        {
          name: "tags",
          in: "query",
          required: false,
          description: "Filter by tags",
          schema: { type: "array", items: { type: "string" } },
        },
      ],
    };
    const operation = {
      parameters: [
        { name: "session", in: "cookie", schema: { type: "string" } },
        { name: "petId", in: "path", required: false, schema: { type: "string" } },
      ],
    };
    const pathItemSnapshot = JSON.parse(JSON.stringify(pathItem));
    const operationSnapshot = JSON.parse(JSON.stringify(operation));

    const result = collectParameters(pathItem, operation, "/pets/{petId}", identity);
    const collected: Parameter | undefined = result.parameters[0];
    expect(collected).toBeDefined();
    collected!.schema.type = "mutated";

    expect(pathItem).toEqual(pathItemSnapshot);
    expect(operation).toEqual(operationSnapshot);
  });
});
