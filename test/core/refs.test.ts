import { describe, expect, it } from "vitest";

import {
  classifyRef,
  containsExternalRef,
  resolveDeep,
  resolveInternalRef,
  tryResolveRef,
} from "../../src/core/refs.js";
import { OpenApiParseError } from "../../src/core/types.js";

/** Minimal document exercising nested pointers, arrays, and escapes. */
const doc = {
  openapi: "3.0.3",
  paths: {
    "/pets": {
      get: {
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          tag: { $ref: "#/components/schemas/Tag" },
        },
      },
      Tag: { type: "string" },
      Bag: {
        type: "array",
        items: { $ref: "#/components/schemas/Pet" },
      },
    },
    parameters: {
      petId: { name: "petId", in: "path", required: true, schema: { type: "string" } },
    },
  },
};

/** Escaped-pointer document (`~0` → `~`, `~1` → `/`). */
const escaped = {
  a: {
    "b/c": 1,
    "d~e": 2,
    "f~/g": 3,
    "~1": 4,
  },
};

/** Percent-encoded tokens. */
const encoded = {
  a: {
    "pet id": 1,
    "caf\u00e9": 2,
    "a/b": 3,
  },
};

/**
 * Assert that `fn` throws an {@link OpenApiParseError} with the given code.
 *
 * @param fn - Function expected to throw.
 * @param code - Expected machine-readable error code.
 * @returns The caught error for further assertions.
 */
function expectParseError(
  fn: () => unknown,
  code: OpenApiParseError["code"],
): OpenApiParseError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OpenApiParseError);
    const parseError = error as OpenApiParseError;
    expect(parseError.code).toBe(code);
    return parseError;
  }
  throw new Error(`expected function to throw an OpenApiParseError with code "${code}"`);
}

describe("classifyRef", () => {
  it("classifies '#/' pointers and '#' as internal", () => {
    expect(classifyRef("#/components/schemas/Pet")).toBe("internal");
    expect(classifyRef("#/paths/~1pets")).toBe("internal");
    expect(classifyRef("#")).toBe("internal");
  });

  it("classifies everything else as external", () => {
    expect(classifyRef("https://example.com/schemas/Pet.json")).toBe("external");
    expect(classifyRef("http://example.com/pet.json#/Pet")).toBe("external");
    expect(classifyRef("file:///tmp/pet.json#/Pet")).toBe("external");
    expect(classifyRef("./other.yaml#/Pet")).toBe("external");
    expect(classifyRef("Pet")).toBe("external");
    expect(classifyRef("#components/schemas/Pet")).toBe("external");
    expect(classifyRef("")).toBe("external");
  });
});

describe("resolveInternalRef", () => {
  it("resolves nested JSON pointers", () => {
    expect(resolveInternalRef(doc, "#/components/schemas/Pet")).toEqual(
      doc.components.schemas.Pet,
    );
    expect(resolveInternalRef(doc, "#/components/parameters/petId")).toEqual(
      doc.components.parameters.petId,
    );
  });

  it("resolves pointers through objects and array indices", () => {
    expect(resolveInternalRef(doc, "#/paths/~1pets/get/parameters/0/name")).toBe("limit");
    expect(resolveInternalRef(doc, "#/paths/~1pets/get/parameters/0/schema/type")).toBe(
      "integer",
    );
  });

  it("resolves '#' to the whole document", () => {
    expect(resolveInternalRef(doc, "#")).toBe(doc);
  });

  it("decodes ~1 before ~0 in pointer tokens", () => {
    expect(resolveInternalRef(escaped, "#/a/b~1c")).toBe(1);
    expect(resolveInternalRef(escaped, "#/a/d~0e")).toBe(2);
    expect(resolveInternalRef(escaped, "#/a/f~0~1g")).toBe(3);
    // "~01" is the escaped form of the literal property name "~1".
    expect(resolveInternalRef(escaped, "#/a/~01")).toBe(4);
  });

  it("percent-decodes pointer tokens", () => {
    expect(resolveInternalRef(encoded, "#/a/pet%20id")).toBe(1);
    expect(resolveInternalRef(encoded, "#/a/caf%C3%A9")).toBe(2);
    // %7E1 percent-decodes to "~1", which then unescapes to "/".
    expect(resolveInternalRef(encoded, "#/a/a%7E1b")).toBe(3);
  });

  it("throws a typed unresolvable-ref error for a missing pointer", () => {
    const error = expectParseError(
      () => resolveInternalRef(doc, "#/components/schemas/Missing"),
      "unresolvable-ref",
    );
    expect(error.pointer).toBe("#/components/schemas/Missing");
  });

  it("throws unresolvable-ref when a token traverses a non-object", () => {
    expectParseError(
      () => resolveInternalRef(doc, "#/components/schemas/Pet/properties/name/type/deeper"),
      "unresolvable-ref",
    );
    expectParseError(
      () => resolveInternalRef(doc, "#/paths/~1pets/get/parameters/9"),
      "unresolvable-ref",
    );
    expectParseError(
      () => resolveInternalRef(doc, "#/paths/~1pets/get/parameters/nope"),
      "unresolvable-ref",
    );
  });

  it("does not throw for external refs and returns them unchanged", () => {
    const external = "https://example.com/schemas/Pet.json";
    expect(() => resolveInternalRef(doc, external)).not.toThrow();
    expect(resolveInternalRef(doc, external)).toBe(external);
  });
});

describe("tryResolveRef", () => {
  it("returns a resolved result for internal pointers", () => {
    const result = tryResolveRef(doc, "#/components/schemas/Pet");
    expect(result).toEqual({ kind: "resolved", value: doc.components.schemas.Pet });
  });

  it("returns external for non-internal refs without throwing", () => {
    const external = "file:///tmp/pet.json#/Pet";
    expect(tryResolveRef(doc, external)).toEqual({ kind: "external", ref: external });
  });

  it("returns unresolved for missing internal pointers without throwing", () => {
    expect(tryResolveRef(doc, "#/components/schemas/Missing")).toEqual({
      kind: "unresolved",
      ref: "#/components/schemas/Missing",
    });
  });
});

describe("resolveDeep", () => {
  it("replaces an internal $ref with its resolved target", () => {
    expect(resolveDeep(doc, { $ref: "#/components/schemas/Pet" })).toEqual({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        // Nested refs inside the target are resolved too.
        tag: { type: "string" },
      },
    });
  });

  it("resolves refs nested inside objects and arrays", () => {
    const value = {
      type: "array",
      items: { $ref: "#/components/schemas/Bag" },
      extra: [{ $ref: "#/components/schemas/Tag" }, { type: "integer" }],
    };
    expect(resolveDeep(doc, value)).toEqual({
      type: "array",
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            tag: { type: "string" },
          },
        },
      },
      extra: [{ type: "string" }, { type: "integer" }],
    });
  });

  it("follows $ref chains", () => {
    const chained = {
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { $ref: "#/components/schemas/C" },
          C: { type: "string" },
        },
      },
    };
    expect(resolveDeep(chained, { $ref: "#/components/schemas/A" })).toEqual({
      type: "string",
    });
  });

  it("leaves external refs structurally untouched", () => {
    const external = "https://example.com/schemas/Pet.json";
    const value = {
      type: "object",
      properties: { pet: { $ref: external } },
      list: [{ $ref: "./other.yaml#/Thing" }],
    };
    const result = resolveDeep(doc, value);
    expect(result).toEqual(value);
    expect(containsExternalRef(result)).toBe(external);
  });

  it("throws ref-cycle for a self-referencing schema", () => {
    const self = {
      components: { schemas: { Node: { $ref: "#/components/schemas/Node" } } },
    };
    const error = expectParseError(
      () => resolveDeep(self, { $ref: "#/components/schemas/Node" }),
      "ref-cycle",
    );
    expect(error.pointer).toBe("#/components/schemas/Node");
  });

  it("throws ref-cycle for an A -> B -> A chain", () => {
    const cyclic = {
      components: {
        schemas: {
          A: { $ref: "#/components/schemas/B" },
          B: { $ref: "#/components/schemas/A" },
        },
      },
    };
    const error = expectParseError(
      () => resolveDeep(cyclic, { $ref: "#/components/schemas/A" }),
      "ref-cycle",
    );
    // A is pushed, then B, then A is seen again on the stack.
    expect(error.pointer).toBe("#/components/schemas/A");
  });

  it("throws ref-cycle when a recursive schema ref appears inside a target", () => {
    const recursive = {
      components: {
        schemas: {
          Tree: {
            type: "object",
            properties: { child: { $ref: "#/components/schemas/Tree" } },
          },
        },
      },
    };
    const error = expectParseError(
      () => resolveDeep(recursive, { $ref: "#/components/schemas/Tree" }),
      "ref-cycle",
    );
    expect(error.pointer).toBe("#/components/schemas/Tree");
  });

  it("enforces a depth cap of 32 distinct ref expansions", () => {
    const schemas: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) {
      schemas[`S${index}`] = { $ref: `#/components/schemas/S${index + 1}` };
    }
    schemas["S40"] = { type: "string" };
    const deepDoc = { components: { schemas } };

    const error = expectParseError(
      () => resolveDeep(deepDoc, { $ref: "#/components/schemas/S0" }),
      "ref-cycle",
    );
    expect(error.pointer).toBe("#/components/schemas/S32");
    expect(error.message).toMatch(/depth of 32/i);
  });

  it("throws unresolvable-ref for a missing internal ref", () => {
    const error = expectParseError(
      () => resolveDeep(doc, { type: "object", properties: { x: { $ref: "#/missing" } } }),
      "unresolvable-ref",
    );
    expect(error.pointer).toBe("#/missing");
  });

  it("does not mutate its inputs and returns a fresh copy", () => {
    const value = {
      type: "object",
      properties: {
        pet: { $ref: "#/components/schemas/Pet" },
        names: [{ type: "string" }],
      },
    };
    const docBefore = structuredClone(doc);
    const valueBefore = structuredClone(value);

    const result = resolveDeep(doc, value) as {
      type: string;
      properties: { pet: { properties: { name: { type: string } } }; names: unknown[] };
    };

    expect(doc).toEqual(docBefore);
    expect(value).toEqual(valueBefore);

    // The result must not alias containers in the input or the document.
    expect(result).not.toBe(value);
    expect(result.properties).not.toBe(value.properties);
    expect(result.properties.pet).not.toBe(doc.components.schemas.Pet);
    expect(result.properties.names).not.toBe(value.properties.names);

    result.properties.pet.properties.name.type = "integer";
    expect(doc).toEqual(docBefore);
    expect(value).toEqual(valueBefore);
  });

  it("handles plain arrays", () => {
    const value = [{ $ref: "#/components/schemas/Tag" }, { type: "number" }, null, "x"];
    const result = resolveDeep(doc, value);
    expect(result).toEqual([{ type: "string" }, { type: "number" }, null, "x"]);
    expect(result).not.toBe(value);
  });

  it("returns primitives and empty structures unchanged in value", () => {
    expect(resolveDeep(doc, null)).toBeNull();
    expect(resolveDeep(doc, 42)).toBe(42);
    expect(resolveDeep(doc, "text")).toBe("text");
    expect(resolveDeep(doc, {})).toEqual({});
    expect(resolveDeep(doc, [])).toEqual([]);
  });
});

describe("containsExternalRef", () => {
  it("returns null when there are no external refs", () => {
    expect(containsExternalRef({ $ref: "#/components/schemas/Pet" })).toBeNull();
    expect(containsExternalRef(doc.components.schemas.Pet)).toBeNull();
    expect(containsExternalRef(null)).toBeNull();
    expect(containsExternalRef("https://not-a-ref.example.com")).toBeNull();
  });

  it("finds the first external ref in depth-first order", () => {
    const value = {
      type: "object",
      properties: {
        first: { $ref: "https://example.com/First.json" },
        second: { items: [{ $ref: "file:///tmp/Second.json" }] },
      },
    };
    expect(containsExternalRef(value)).toBe("https://example.com/First.json");
  });

  it("survives cyclic object graphs", () => {
    const cyclic: Record<string, unknown> = { type: "object", properties: {} };
    cyclic["self"] = cyclic;
    expect(containsExternalRef(cyclic)).toBeNull();
  });
});
