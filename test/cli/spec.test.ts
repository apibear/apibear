import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SpecLoadError } from "../../src/cli/errors.js";
import { loadSpec } from "../../src/cli/spec.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const fixtures = path.join(here, "fixtures");
const petstoreJson = path.join(fixtures, "petstore.json");
const petstoreYaml = path.join(fixtures, "petstore.yaml");

/** Await a call expected to reject and return the thrown value for inspection. */
async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected the promise to reject");
}

/** Grab a port that was just closed, so connecting to it should fail. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

describe("loadSpec", () => {
  let server: Server;
  let petstoreBody: string;
  let specUrl: string;
  let specRequests = 0;

  beforeAll(async () => {
    petstoreBody = await fs.readFile(petstoreJson, "utf8");
    server = createServer((request, response) => {
      if (request.url === "/spec.json") {
        specRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(petstoreBody);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    specUrl = `http://127.0.0.1:${address.port}/spec.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("loads a relative path resolved against the given cwd", async () => {
    const doc = await loadSpec("test/cli/fixtures/petstore.json", packageRoot);

    expect(doc.openapi).toBe("3.0.3");
    expect(Object.keys(doc.paths as Record<string, unknown>)).toEqual(["/pets", "/pets/{petId}"]);
  });

  it("loads an absolute path", async () => {
    const doc = await loadSpec(petstoreJson);

    expect(doc.openapi).toBe("3.0.3");
    expect((doc.info as Record<string, unknown>).title).toBe("Swagger Petstore");
  });

  it("loads a YAML document", async () => {
    const doc = await loadSpec(petstoreYaml);

    expect(doc.openapi).toBe("3.0.3");
    expect((doc.info as Record<string, unknown>).title).toBe("Swagger Petstore");
  });

  it("loads a document over http on a loopback URL, fetching it once", async () => {
    const before = specRequests;
    const doc = await loadSpec(specUrl);

    expect(specRequests - before).toBe(1);
    expect(doc.openapi).toBe("3.0.3");
    expect((doc.info as Record<string, unknown>).title).toBe("Swagger Petstore");
  });

  it("dereferences non-circular internal $refs", async () => {
    const doc = await loadSpec(petstoreJson);
    const paths = doc.paths as Record<string, any>;
    const bodySchema = paths["/pets"].post.requestBody.content["application/json"].schema;

    expect(bodySchema).toEqual({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        tag: { type: "string" },
      },
    });
    expect(JSON.stringify(doc)).not.toContain("$ref");
  });

  it("throws SpecLoadError for a missing file, naming the resolved path", async () => {
    const missing = path.join(fixtures, "does-not-exist.json");
    const thrown = await capture(loadSpec(missing));

    expect(thrown).toBeInstanceOf(SpecLoadError);
    expect((thrown as SpecLoadError).message).toContain(missing);
    expect((thrown as SpecLoadError).source).toBe(missing);
  });

  it("throws SpecLoadError for an unreachable URL", async () => {
    const port = await closedPort();
    const url = `http://127.0.0.1:${port}/spec.json`;
    const thrown = await capture(loadSpec(url));

    expect(thrown).toBeInstanceOf(SpecLoadError);
    expect((thrown as SpecLoadError).message).toContain(url);
  });

  it("throws SpecLoadError for an invalid OpenAPI document", async () => {
    const thrown = await capture(loadSpec(path.join(fixtures, "invalid-spec.json")));

    expect(thrown).toBeInstanceOf(SpecLoadError);
    expect((thrown as SpecLoadError).message).toMatch(/failed to load spec/);
  });

  it("rejects Swagger/OpenAPI 2.0 with the exact message", async () => {
    const thrown = await capture(loadSpec(path.join(fixtures, "swagger2.json")));

    expect(thrown).toBeInstanceOf(SpecLoadError);
    expect((thrown as SpecLoadError).message).toBe(
      `failed to load spec "${path.join(fixtures, "swagger2.json")}": Swagger/OpenAPI 2.0 is not supported; use OpenAPI 3.x`,
    );
  });

  it("loads a circular-$ref document without throwing or looping", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "apibear-circular-"));
    const file = path.join(directory, "circular.json");
    const document = {
      openapi: "3.0.3",
      info: { title: "Circular", version: "1.0.0" },
      servers: [{ url: "https://circular.example.com" }],
      paths: {
        "/nodes": {
          get: {
            operationId: "getNode",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Node" } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              child: { $ref: "#/components/schemas/Node" },
            },
          },
        },
      },
    };

    try {
      await fs.writeFile(file, JSON.stringify(document), "utf8");
      const doc = await loadSpec(file);

      // Circular refs stay as internal $refs, so the result is still serializable.
      expect(() => JSON.stringify(doc)).not.toThrow();
      expect(JSON.stringify(doc)).toContain("#/components/schemas/Node");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("writes nothing to stdout", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await loadSpec(petstoreJson);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
