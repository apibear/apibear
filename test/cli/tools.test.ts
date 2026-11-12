import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { UsageError } from "../../src/cli/errors.js";
import { loadSpec } from "../../src/cli/spec.js";
import { buildTools } from "../../src/cli/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const petstoreJson = path.join(here, "fixtures", "petstore.json");

function captureStream(stream: NodeJS.WriteStream): { chunks: string[]; restore(): void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(stream, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
  return { chunks, restore: () => spy.mockRestore() };
}

describe("buildTools", () => {
  let doc: Record<string, unknown>;

  beforeAll(async () => {
    doc = await loadSpec(petstoreJson);
  });

  it("builds one tool per supported, non-deprecated operation", () => {
    const captured = captureStream(process.stderr);
    try {
      const loaded = buildTools(doc, undefined, "petstore.json");

      expect(loaded.tools.map((tool) => tool.name)).toEqual([
        "listPets",
        "createPet",
        "showPetById",
      ]);
      expect([...loaded.byName.keys()]).toEqual(["listPets", "createPet", "showPetById"]);
      expect(loaded.byName.get("createPet")).toBe(
        loaded.tools.find((tool) => tool.name === "createPet"),
      );
      expect(captured.chunks.join("")).toContain("serving 3 tools from");
    } finally {
      captured.restore();
    }
  });

  it("exposes the document summary", () => {
    const captured = captureStream(process.stderr);
    try {
      const loaded = buildTools(doc, undefined, "petstore.json");

      expect(loaded.api).toEqual({
        title: "Swagger Petstore",
        version: "1.0.0",
        baseUrl: "https://petstore.example.com/api/v3",
      });
      expect(loaded.warnings).toEqual([]);
    } finally {
      captured.restore();
    }
  });

  it("filters with --only", () => {
    const captured = captureStream(process.stderr);
    try {
      const loaded = buildTools(doc, ["showPetById"], "petstore.json");

      expect(loaded.tools).toHaveLength(1);
      expect(loaded.tools[0]?.name).toBe("showPetById");
    } finally {
      captured.restore();
    }
  });

  it("warns about unknown --only ids, keeps known ones, and stays off stdout", () => {
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    try {
      const loaded = buildTools(doc, ["showPetById", "nope"], "petstore.json");

      expect(loaded.tools.map((tool) => tool.name)).toEqual(["showPetById"]);
      expect(stderr.chunks.join("")).toContain("unknown-filter-id");
      expect(stdout.chunks.join("")).toBe("");
    } finally {
      stderr.restore();
      stdout.restore();
    }
  });

  it("throws UsageError when --only matches nothing", () => {
    const captured = captureStream(process.stderr);
    try {
      expect(() => buildTools(doc, ["nope"], "petstore.json")).toThrow(UsageError);
      expect(() => buildTools(doc, ["nope"], "petstore.json")).toThrow(
        /no tools were generated from "petstore\.json"/,
      );
    } finally {
      captured.restore();
    }
  });

  it("wraps OpenApiParseError as UsageError", () => {
    expect(() => buildTools({}, undefined, "empty.json")).toThrow(UsageError);
    expect(() => buildTools({}, undefined, "empty.json")).toThrow(
      /invalid OpenAPI document "empty\.json"/,
    );
  });
});
