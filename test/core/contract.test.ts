import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import petstoreJson from "./fixtures/petstore.json";
import refsJson from "./fixtures/refs.json";
import * as publicApi from "../../src/core/index.js";
import { toMcpTool } from "../../src/core/mcp.js";
import { parseOpenApiToTools } from "../../src/core/parse.js";
import type { ParsedTool } from "../../src/core/types.js";

/** URL of the package manifest under audit. */
const PACKAGE_URL = new URL("../../package.json", import.meta.url);

/** URL of the environment-agnostic `src/core/` tree under audit. */
const SRC_URL = new URL("../../src/core/", import.meta.url);

/** Patterns that must never appear in the environment-agnostic source tree. */
const FORBIDDEN_SOURCE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /node:/, label: 'a "node:" specifier' },
  { pattern: /from\s+["']fs["']/, label: 'an `fs` import' },
  { pattern: /from\s+["']path["']/, label: 'a `path` import' },
  { pattern: /\brequire\s*\(/, label: "a `require(` call" },
  { pattern: /\bfetch\s*\(/, label: "a `fetch(` call" },
];

/**
 * Recursively list every file in a directory URL.
 *
 * @param directory - Directory URL ending in `/`.
 * @returns Absolute file URLs in depth-first directory order.
 */
function collectFiles(directory: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryUrl = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      files.push(...collectFiles(new URL(`${entry.name}/`, directory)));
    } else if (entry.isFile()) {
      files.push(entryUrl);
    }
  }
  return files;
}

/**
 * Load a fresh copy of a fixture document for parsing.
 *
 * @param fixture - Imported JSON fixture module.
 */
function load(fixture: unknown): Record<string, unknown> {
  return structuredClone(fixture) as Record<string, unknown>;
}

/** Every tool produced by the two end-to-end fixtures. */
const fixtureTools: ParsedTool[] = [
  ...parseOpenApiToTools(load(petstoreJson)).tools,
  ...parseOpenApiToTools(load(refsJson)).tools,
];

describe("package contract — dependency-free library entry", () => {
  it("imports only relative modules from src/core/", () => {
    // The package ships CLI dependencies, but the library entry must not pull
    // any of them in: everything under src/core/ resolves to sibling files.
    const files = collectFiles(SRC_URL).filter((file) => file.pathname.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const specifier = /(?:^|\n)\s*(?:import|export)\b[^"';]*?from\s+["']([^"']+)["']/g;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(specifier)) {
        expect(match[1], `${file.pathname} imports "${match[1]}"`).toMatch(/^\.\.?\//);
      }
    }
  });

  it("is the manifest of the apibear package", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_URL, "utf8")) as { name?: string };
    expect(manifest.name).toBe("apibear");
  });
});

describe("package contract — MCP wire projection", () => {
  it("parses a non-trivial set of tools from both fixtures", () => {
    expect(fixtureTools.length).toBe(3 + 4);
    expect(fixtureTools.every((tool) => tool.metadata !== undefined)).toBe(true);
  });

  it("projects every fixture tool onto exactly { name, description?, inputSchema }", () => {
    expect(fixtureTools.length).toBeGreaterThan(0);

    for (const tool of fixtureTools) {
      const wire = toMcpTool(tool);

      const expected: {
        name: string;
        description?: string;
        inputSchema: ParsedTool["inputSchema"];
      } = {
        name: tool.name,
        inputSchema: tool.inputSchema,
      };
      if (tool.description !== undefined) {
        expected.description = tool.description;
      }

      expect(wire, `wire projection for "${tool.name}"`).toEqual(expected);
      expect(Object.keys(wire).sort()).toEqual(
        tool.description === undefined
          ? ["inputSchema", "name"]
          : ["description", "inputSchema", "name"],
      );
      expect(wire).not.toHaveProperty("metadata");
      expect(JSON.stringify(wire)).not.toContain("metadata");
      expect(wire).not.toBe(tool);
    }
  });

  it("emits MCP-valid tool names for every fixture tool", () => {
    expect(fixtureTools.length).toBeGreaterThan(0);

    for (const tool of fixtureTools) {
      expect(tool.name, `tool name "${tool.name}"`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("package contract — environment-agnostic source", () => {
  it("uses no Node-only APIs or global fetch in src/core/", () => {
    const files = collectFiles(SRC_URL);
    expect(files.length).toBeGreaterThan(0);

    const typescriptFiles = files.filter((file) => file.pathname.endsWith(".ts"));
    expect(typescriptFiles.length).toBe(files.length);

    for (const file of typescriptFiles) {
      const source = readFileSync(file, "utf8");
      for (const { pattern, label } of FORBIDDEN_SOURCE_PATTERNS) {
        expect(pattern.test(source), `${file.pathname} contains ${label}`).toBe(false);
      }
    }
  });
});

describe("package contract — public runtime exports", () => {
  it("exports exactly parseOpenApiToTools, toMcpTool, and OpenApiParseError", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      "OpenApiParseError",
      "parseOpenApiToTools",
      "toMcpTool",
    ]);
    expect(typeof publicApi.parseOpenApiToTools).toBe("function");
    expect(typeof publicApi.toMcpTool).toBe("function");
    expect(typeof publicApi.OpenApiParseError).toBe("function");
  });
});
