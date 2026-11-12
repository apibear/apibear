/**
 * End-to-end suite (task 2.6).
 *
 * Every test spawns the BUILT artifact (`dist/cli.js`) as a real child process
 * with stdio pipes, speaks newline-delimited JSON-RPC 2.0 to it, and points it
 * at a `127.0.0.1` fixture API. There is no network egress and no leaked
 * process: each client is closed in `afterEach` (stdin end, then SIGKILL after
 * a bounded grace period if needed).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CLI_PATH, McpStdioClient, type ToolCallResult } from "./helpers/mcp-client.js";
import { startFixtureApi, type FixtureApi } from "./helpers/fixture-api.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.join(here, "fixtures", "petstore.json");
const EXPECTED_TOOLS = ["listPets", "createPet", "showPetById"];

let fixture: FixtureApi;
const clients: McpStdioClient[] = [];

/** Track a client so `afterEach` always closes it, even after a failed test. */
function track(client: McpStdioClient): McpStdioClient {
  clients.push(client);
  return client;
}

/** Spawn the CLI, run the MCP handshake, and return the client. */
async function startClient(extraArgs: string[] = []): Promise<McpStdioClient> {
  const client = await McpStdioClient.start([
    "--spec",
    SPEC,
    "--base-url",
    fixture.baseUrl,
    ...extraArgs,
  ]);
  track(client);
  await client.initialize();
  return client;
}

/** Concatenate all text blocks of a tool result. */
function textOf(result: ToolCallResult): string {
  return result.content.map((block) => block.text).join("");
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI to completion as a plain process (no MCP session). */
function runCli(args: string[], timeoutMs = 10_000): Promise<CliRun> {
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not exit within ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      "dist/cli.js missing — run `npm run build` " +
        "(npm test does this automatically via pretest)",
    );
  }
  fixture = await startFixtureApi();
});

beforeEach(() => {
  fixture.clear();
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.dispose();
    // STDOUT IS THE MCP TRANSPORT: any non-JSON line would corrupt the stream.
    expect(
      client.nonJsonStdout,
      `non-JSON stdout lines (stderr follows):\n${client.stderr}`,
    ).toEqual([]);
  }
});

afterAll(async () => {
  await fixture.close();
});

describe("network isolation", () => {
  it("binds the fixture API to 127.0.0.1 and uses a loopback base URL", () => {
    expect(fixture.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
    const address = fixture.address();
    expect(address.address).toBe("127.0.0.1");
    expect(address.family).toBe("IPv4");
    expect(address.port).toBe(fixture.port);
    expect(address.port).toBeGreaterThan(0);
  });
});

describe("tools/list", () => {
  it("returns exactly the three expected tools with inputSchema and no metadata", async () => {
    const client = await startClient();

    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);

    expect(names).toHaveLength(3);
    expect(new Set(names)).toEqual(new Set(EXPECTED_TOOLS));

    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeTypeOf("object");
      expect(tool.inputSchema).not.toBeNull();
      expect(Array.isArray(tool.inputSchema)).toBe(false);
      for (const key of Object.keys(tool)) {
        expect(["name", "description", "inputSchema"]).toContain(key);
      }
    }

    // The parser's runner-only metadata must never cross the wire.
    expect(JSON.stringify(result)).not.toContain('"metadata"');
  });
});

describe("tools/call showPetById", () => {
  it("injects CLI headers and returns the fixture JSON with no isError", async () => {
    const client = await startClient(["--header", "X-Test: yes"]);

    const result = await client.callTool("showPetById", { petId: "42" });

    expect(fixture.hits).toHaveLength(1);
    const hit = fixture.hits[0];
    expect(hit?.path).toBe("/pets/42");
    expect(hit?.method).toBe("GET");
    expect(hit?.headers["x-test"]).toBe("yes");

    expect(result.content[0]?.type).toBe("text");
    const payload = JSON.parse(textOf(result)) as { id: string; name: string };
    expect(payload.id).toBe("42");
    expect(payload.name).toBe("Pet 42");
    expect("isError" in result).toBe(false);
  });

  it("reports a missing required argument without calling upstream", async () => {
    const client = await startClient();

    const result = await client.callTool("showPetById", {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("petId");
    expect(textOf(result)).toContain("missing required argument");
    expect(fixture.hits).toHaveLength(0);
  });

  it("surfaces an upstream 404 as an isError result with the body", async () => {
    const client = await startClient();

    const result = await client.callTool("showPetById", { petId: "missing" });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.startsWith("HTTP 404")).toBe(true);
    expect(text).toContain("pet not found");
  });

  it("times out a slow upstream but keeps the server alive", async () => {
    const client = await startClient(["--timeout", "100"]);

    const startedAt = Date.now();
    const result = await client.callTool("showPetById", { petId: "slow" });
    const elapsed = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("timed out");
    // The tool result must come back promptly, not after the 500ms stub.
    expect(elapsed).toBeLessThan(5000);

    // The same process must still serve requests after the abort.
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toHaveLength(3);
  });
});

describe("dispatch errors", () => {
  it("lists available tools for an unknown tool name without calling upstream", async () => {
    const client = await startClient();

    const result = await client.callTool("doesNotExist", {});

    expect(result.isError).toBe(true);
    const text = textOf(result);
    for (const name of EXPECTED_TOOLS) {
      expect(text).toContain(name);
    }
    expect(fixture.hits).toHaveLength(0);
  });
});

describe("--only filtering", () => {
  it("exposes exactly the selected tool", async () => {
    const client = await startClient(["--only", "showPetById"]);

    const result = await client.listTools();

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]?.name).toBe("showPetById");
  });

  it("warns about unknown ids on stderr only", async () => {
    const client = await startClient(["--only", "showPetById,nope"]);

    await client.waitForStderr(/unknown-filter-id/);

    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(["showPetById"]);

    expect(client.stderr).toContain("unknown-filter-id");
    expect(client.stderr).toContain("nope");
    expect(client.nonJsonStdout).toEqual([]);
  });
});

describe("header security", () => {
  it("injects Authorization upstream without leaking its value to stderr", async () => {
    const client = await startClient([
      "--header",
      "Authorization: Bearer sk-SECRET-123",
    ]);

    await client.waitForStderr("injecting headers: Authorization");
    await client.callTool("showPetById", { petId: "42" });

    expect(client.stderr).toContain("injecting headers: Authorization");
    expect(client.stderr).not.toContain("sk-SECRET-123");

    expect(fixture.hits).toHaveLength(1);
    expect(fixture.hits[0]?.headers["authorization"]).toBe("Bearer sk-SECRET-123");
    // Only the header NAME may appear in diagnostics.
    expect(client.stderr).not.toContain("Bearer");
  });
});

describe("request serialization", () => {
  it("serializes array query parameters as repeated keys", async () => {
    const client = await startClient();

    const result = await client.callTool("listPets", {
      tags: ["a", "b"],
      limit: 5,
    });

    expect(result.isError).toBeUndefined();
    expect(fixture.hits).toHaveLength(1);
    const hit = fixture.hits[0];
    expect(hit?.path).toBe("/pets");
    expect(hit?.query["tags"]).toEqual(["a", "b"]);
    expect(hit?.query["limit"]).toBe("5");
  });

  it("sends a JSON body for createPet and returns the created pet", async () => {
    const client = await startClient();

    const result = await client.callTool("createPet", { name: "Fido", tag: "dog" });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Fido");

    expect(fixture.hits).toHaveLength(1);
    const hit = fixture.hits[0];
    expect(hit?.method).toBe("POST");
    expect(hit?.path).toBe("/pets");
    expect(hit?.headers["content-type"]).toBe("application/json");
    expect(hit?.body).toEqual({ name: "Fido", tag: "dog" });
  });
});

describe("lifecycle", () => {
  it("exits 0 when the client closes stdin", async () => {
    const client = await startClient();

    const code = await client.close();

    expect(code).toBe(0);
    expect(client.usedKillFallback).toBe(false);
    expect(client.signal).toBeNull();
  });
});

describe("process-level CLI", () => {
  it("--list-tools prints one line per tool to stdout and exits 0", async () => {
    const { code, stdout } = await runCli(["--spec", SPEC, "--list-tools"]);

    expect(code).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.startsWith("listPets - ")).toBe(true);
    expect(lines[1]?.startsWith("createPet - ")).toBe(true);
    expect(lines[2]?.startsWith("showPetById - ")).toBe(true);
  });

  it("exits 2 with empty stdout when --spec is missing", async () => {
    const { code, stdout, stderr } = await runCli(["--list-tools"]);

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).toContain("--spec is required");
  });

  it("exits 2 with empty stdout when the spec path does not exist", async () => {
    const missing = path.join(here, "fixtures", "does-not-exist.json");
    const { code, stdout, stderr } = await runCli([
      "--spec",
      missing,
      "--list-tools",
    ]);

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(missing);
  });

  it("exits 2 with empty stdout for a malformed --header", async () => {
    const { code, stdout, stderr } = await runCli([
      "--spec",
      SPEC,
      "--header",
      "nocolon",
    ]);

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--header");
  });

  it("--version prints 0.1.0 and exits 0", async () => {
    const { code, stdout } = await runCli(["--version"]);

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("0.1.0");
  });
});
