/**
 * MCP stdio server assembly (task 2.5).
 *
 * STDOUT IS THE MCP TRANSPORT: this module never writes to stdout directly.
 * The SDK transport owns stdout; every diagnostic goes through `./logger.js`
 * (stderr). Header values are never logged — only their names.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toMcpTool } from "../core/index.js";

import { executeTool } from "./http.js";
import type { FetchLike, ToolResult } from "./http.js";
import { error as logError, log } from "./logger.js";
import type { LoadedTools } from "./tools.js";
import { VERSION } from "./version.js";

/** Configuration for the MCP server and its tool dispatcher. */
export interface ServerConfig {
  loaded: LoadedTools;
  headers: Record<string, string>;
  baseUrl?: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

/** Most tool names listed in an "unknown tool" error (large specs have hundreds). */
export const MAX_LISTED_TOOL_NAMES = 50;

/** `a, b, c` — or the first {@link MAX_LISTED_TOOL_NAMES} names and a count of the rest. */
function listToolNames(names: string[]): string {
  if (names.length <= MAX_LISTED_TOOL_NAMES) {
    return names.join(", ");
  }
  const shown = names.slice(0, MAX_LISTED_TOOL_NAMES).join(", ");
  return `${shown}, … and ${names.length - MAX_LISTED_TOOL_NAMES} more`;
}

/** Build the tool-call dispatcher used by the MCP `CallTool` handler. */
export function createDispatcher(
  config: ServerConfig,
): (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult> {
  return async (name, args, signal) => {
    const tool = config.loaded.byName.get(name);
    if (tool === undefined) {
      const available = listToolNames([...config.loaded.byName.keys()]);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `unknown tool: ${name}. Available tools: ${available}`,
          },
        ],
      };
    }

    try {
      return await executeTool(tool, args, {
        cliHeaders: config.headers,
        baseUrl: config.baseUrl ?? null,
        timeoutMs: config.timeoutMs,
        ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (thrown) {
      // `executeTool` never throws by contract; this is defence for a genuine bug.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return {
        isError: true,
        content: [{ type: "text", text: `internal error: ${message}` }],
      };
    }
  };
}

/** Resolve after the current and already-queued microtasks/immediates run. */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Upper bound on how long shutdown waits for a response still in production. */
const SHUTDOWN_GRACE_MS = 2000;

/**
 * Wait until both request handlers and protocol writes are idle.
 *
 * MCP clients signal "stop" by closing stdin; a response that was already
 * being produced should still reach the pipe, but the process must not linger
 * on a slow upstream, hence the bounded grace period.
 */
async function settleIdle(isIdle: () => boolean): Promise<void> {
  await nextTurn();
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (!isIdle() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

/** Give stdout one last turn so buffered protocol writes reach the OS pipe. */
async function flushStdout(): Promise<void> {
  if (process.stdout.writableLength > 0) {
    await new Promise<void>((resolve) => {
      process.stdout.once("drain", () => resolve());
    });
  }
  await nextTurn();
}

/**
 * Create and connect the stdio MCP server.
 *
 * Resolves once the server is connected; the process stays alive because the
 * stdin pipe is open. The server shuts down gracefully (exit 0) on SIGINT,
 * SIGTERM, or stdin end/close — MCP clients stop servers by closing the pipe,
 * and a lingering process would leak one server per session.
 */
export async function startServer(config: ServerConfig): Promise<void> {
  const dispatch = createDispatcher(config);

  // In-flight bookkeeping for graceful shutdown (see `isIdle` below).
  let inFlightRequests = 0;
  let pendingWrites = 0;
  const isIdle = (): boolean => inFlightRequests === 0 && pendingWrites === 0;

  const server = new Server(
    { name: "apibear", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    inFlightRequests += 1;
    try {
      return { tools: config.loaded.tools.map(toMcpTool) };
    } finally {
      inFlightRequests -= 1;
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Unknown tools are normal tool results, never JSON-RPC errors, so the LLM
    // can read the available names and self-correct. `extra.signal` aborts
    // when the client cancels, which aborts the upstream request too.
    inFlightRequests += 1;
    try {
      return (await dispatch(
        request.params.name,
        request.params.arguments ?? {},
        extra.signal,
      )) as CallToolResult;
    } finally {
      inFlightRequests -= 1;
    }
  });

  server.onerror = (thrown) => logError(thrown);

  const transport = new StdioServerTransport();

  // Track in-flight protocol writes as well: a response already queued must
  // reach the pipe before the process exits.
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    pendingWrites += 1;
    try {
      await send(message);
    } finally {
      pendingWrites -= 1;
    }
  };

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await settleIdle(isIdle);
    try {
      await server.close();
    } catch {
      // Already closed/broken transport: nothing left to clean up.
    }
    await settleIdle(() => pendingWrites === 0);
    await flushStdout();
    process.exit(0);
  };

  const requestShutdown = (): void => {
    void shutdown();
  };

  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
  process.stdin.on("end", requestShutdown);
  process.stdin.on("close", requestShutdown);

  await server.connect(transport);

  log(`ready: ${config.loaded.tools.length} tools`);
  const headerNames = Object.keys(config.headers);
  if (headerNames.length > 0) {
    log(`injecting headers: ${headerNames.join(", ")}`);
  }
}
