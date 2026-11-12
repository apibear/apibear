import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { FetchLike, ToolResult } from "../../src/cli/http.js";
import { MAX_LISTED_TOOL_NAMES, createDispatcher } from "../../src/cli/server.js";
import type { ServerConfig } from "../../src/cli/server.js";
import { loadSpec } from "../../src/cli/spec.js";
import { buildTools } from "../../src/cli/tools.js";
import type { LoadedTools } from "../../src/cli/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const petstoreJson = path.join(here, "fixtures", "petstore.json");

let loaded: LoadedTools;

/** JSON response helper for the injected fetch stub. */
function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Build a dispatcher over the petstore fixture; `config` wins over defaults. */
function makeDispatcher(
  fetchImpl: FetchLike,
  config: Partial<Pick<ServerConfig, "headers" | "baseUrl" | "timeoutMs">> = {},
): ReturnType<typeof createDispatcher> {
  return createDispatcher({
    loaded,
    headers: config.headers ?? { "X-Test": "yes" },
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    timeoutMs: config.timeoutMs ?? 5000,
    fetchImpl,
  });
}

/** Read the single text block of a tool result. */
function textOf(result: ToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

beforeAll(async () => {
  // `buildTools` logs "serving N tools"; keep test output clean.
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const doc = await loadSpec(petstoreJson);
    loaded = buildTools(doc, undefined, "petstore.json");
  } finally {
    stderr.mockRestore();
  }
});

describe("createDispatcher", () => {
  it("executes a known tool with CLI headers and the base URL override", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: Parameters<FetchLike>[1]) =>
      jsonResponse({ id: "42", name: "Fido" }),
    );
    const dispatch = makeDispatcher(fetchImpl, { baseUrl: "http://example.test/" });

    const result = await dispatch("showPetById", { petId: "42" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://example.test/pets/42");
    expect(init?.headers?.["X-Test"]).toBe("yes");
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: '{"id":"42","name":"Fido"}' }]);
  });

  it("returns an isError result with the available tools for an unknown name", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const dispatch = makeDispatcher(fetchImpl);

    const result = await dispatch("notATool", {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unknown tool: notATool");
    expect(textOf(result)).toContain("listPets, createPet, showPetById");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps the list of available tools in the unknown-tool error", async () => {
    const template = loaded.tools[0];
    if (template === undefined) {
      throw new Error("fixture has no tools");
    }
    const byName = new Map<string, typeof template>();
    for (let index = 0; index < MAX_LISTED_TOOL_NAMES + 7; index += 1) {
      byName.set(`tool${index}`, { ...template, name: `tool${index}` });
    }
    const dispatch = createDispatcher({
      loaded: { ...loaded, tools: [...byName.values()], byName },
      headers: {},
      timeoutMs: 1_000,
      fetchImpl: vi.fn(async () => jsonResponse({})),
    });

    const text = textOf(await dispatch("nope", {}));

    expect(text).toContain(`tool${MAX_LISTED_TOOL_NAMES - 1}, … and 7 more`);
    expect(text).not.toContain(`tool${MAX_LISTED_TOOL_NAMES},`);
  });

  it("passes the client's cancellation signal through to the upstream request", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({}));
    const dispatch = makeDispatcher(fetchImpl);
    const controller = new AbortController();

    await dispatch("showPetById", { petId: "42" }, controller.signal);
    const signal = fetchImpl.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    controller.abort();

    expect(signal?.aborted).toBe(true);
  });

  it("rejects a missing required argument without calling upstream", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const dispatch = makeDispatcher(fetchImpl);

    const result = await dispatch("showPetById", {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("petId");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a synchronously throwing fetch into an isError result", async () => {
    const fetchImpl = vi.fn((_input: string) => {
      throw new Error("socket boom");
    });
    const dispatch = makeDispatcher(fetchImpl);

    const result = await dispatch("showPetById", { petId: "42" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("socket boom");
  });

  it("falls back to the spec server URL when no base URL override is given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "42" }));
    const dispatch = makeDispatcher(fetchImpl, { baseUrl: undefined });

    const result = await dispatch("showPetById", { petId: "42" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://petstore.example.com/api/v3/pets/42",
      expect.anything(),
    );
    expect(result.isError).toBeUndefined();
  });
});
