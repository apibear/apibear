/**
 * Minimal newline-delimited JSON-RPC 2.0 client for the MCP stdio transport
 * (task 2.6).
 *
 * The TypeScript SDK's `StdioServerTransport` frames messages as one JSON
 * object per line — NOT LSP-style `Content-Length` headers. This client speaks
 * that wire format, records every stdout line so tests can prove the stream is
 * pure protocol, and always lets tests tear the child process down.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the built CLI entry (`dist/cli.js`). */
export const CLI_PATH = path.resolve(here, "..", "..", "..", "dist", "cli.js");

/** One `text` content block in a tool result. */
export interface TextContent {
  type: "text";
  text: string;
}

/** Result payload of a `tools/call` request. */
export interface ToolCallResult {
  content: TextContent[];
  isError?: boolean;
  [key: string]: unknown;
}

/** One tool descriptor returned by `tools/list`. */
export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: unknown;
  [key: string]: unknown;
}

/** Result payload of a `tools/list` request. */
export interface ListToolsResult {
  tools: ToolDescriptor[];
  [key: string]: unknown;
}

/** JSON-RPC error object as sent by the server. */
interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A response still waiting for its matching `id`. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A pending `waitForStderr` call. */
interface StderrWaiter {
  pattern: RegExp;
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Options for {@link McpStdioClient.start}. */
export interface McpStdioClientOptions {
  /** Override the CLI entry point; defaults to {@link CLI_PATH}. */
  cliPath?: string;
  /** Working directory for the child; defaults to the test process cwd. */
  cwd?: string;
  /** Environment for the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default per-request timeout in milliseconds (10s). */
  requestTimeoutMs?: number;
}

/** How long {@link McpStdioClient.close} waits before SIGKILL. */
const CLOSE_TIMEOUT_MS = 5000;

/** Escape a literal string for use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Convert an unknown thrown value into an `Error`. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** A running `node dist/cli.js` process speaking MCP over stdio. */
export class McpStdioClient {
  /** Arguments passed to `node` after the CLI entry point. */
  readonly args: string[];
  /** Every stdout line that parsed as JSON. */
  readonly stdoutLines: unknown[] = [];
  /** Every non-empty stdout line that did NOT parse as JSON. Must stay empty. */
  readonly nonJsonStdout: string[] = [];
  /** Resolves with the child's exit code once its stdio streams are closed. */
  readonly exited: Promise<number | null>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrWaiters: StderrWaiter[] = [];
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextId = 1;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private killFallbackUsed = false;
  private spawnFailure: Error | null = null;

  private constructor(args: string[], options: McpStdioClientOptions) {
    this.args = [...args];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

    const cliPath = options.cliPath ?? CLI_PATH;
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.onStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      this.checkStderrWaiters();
    });

    // A closed pipe is normal when the child exits mid-session; without a
    // listener Node would surface it as an unhandled 'error' event.
    child.stdin.on("error", () => {
      // Ignore: `exited`/pending-request rejection carries the real cause.
    });
    child.on("error", (error: Error) => {
      this.spawnFailure ??= error;
      this.rejectPending(
        new Error(`failed to run MCP CLI (${cliPath}): ${error.message}`),
      );
    });

    this.exited = new Promise<number | null>((resolve) => {
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        this.exitCode = code;
        this.exitSignal = signal;
        this.flushStdoutBuffer();
        this.rejectPending(this.exitedError());
        this.failStderrWaiters(this.exitedError());
        resolve(code);
      });
    });
  }

  /** Spawn the built CLI and start collecting its output. */
  static async start(
    args: string[],
    options: McpStdioClientOptions = {},
  ): Promise<McpStdioClient> {
    return new McpStdioClient(args, options);
  }

  /** stderr collected so far. */
  get stderr(): string {
    return this.stderrBuffer;
  }

  /** Every stdout line collected (parsed JSON values). */
  get stdoutLineCount(): number {
    return this.stdoutLines.length;
  }

  /** The child's PID, if it was spawned. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Whether `close()` had to SIGKILL the child. */
  get usedKillFallback(): boolean {
    return this.killFallbackUsed;
  }

  /** Signal that terminated the child, if any. */
  get signal(): NodeJS.Signals | null {
    return this.exitSignal;
  }

  /** Send a JSON-RPC request and resolve with its `result`. */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.exitCode !== null) {
      return Promise.reject(this.exitedError());
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`timed out after ${timeoutMs}ms waiting for ${method} (id ${id})`),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value: unknown) => {
          resolve(value as T);
        },
        reject,
        timer,
      });

      try {
        this.write({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  /** Send a JSON-RPC notification (no `id`, no response expected). */
  notify(method: string, params?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  /**
   * Perform the MCP handshake: `initialize`, then
   * `notifications/initialized`.
   */
  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  /** Call one MCP tool. */
  callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    return this.request<ToolCallResult>("tools/call", { name, arguments: args });
  }

  /** List the tools the server exposes. */
  listTools(): Promise<ListToolsResult> {
    return this.request<ListToolsResult>("tools/list", {});
  }

  /** Resolve once stderr matches `pattern`, or reject on timeout/exit. */
  waitForStderr(pattern: string | RegExp, timeoutMs = 5000): Promise<void> {
    const regex =
      typeof pattern === "string" ? new RegExp(escapeRegExp(pattern)) : pattern;
    if (regex.test(this.stderrBuffer)) {
      return Promise.resolve();
    }
    if (this.exitCode !== null) {
      return Promise.reject(this.exitedError());
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: StderrWaiter = {
        pattern: regex,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.stderrWaiters.indexOf(waiter);
          if (index !== -1) {
            this.stderrWaiters.splice(index, 1);
          }
          reject(
            new Error(
              `stderr did not match ${String(regex)} within ${timeoutMs}ms; stderr so far:\n${this.stderrBuffer}`,
            ),
          );
        }, timeoutMs),
      };
      this.stderrWaiters.push(waiter);
    });
  }

  /**
   * End stdin (the MCP shutdown signal) and wait for the process to exit.
   *
   * Throws if the process has to be SIGKILLed after {@link CLOSE_TIMEOUT_MS}.
   */
  async close(): Promise<number | null> {
    if (this.exitCode !== null) {
      return this.exitCode;
    }

    this.child.stdin.end();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, CLOSE_TIMEOUT_MS);
    });

    const outcome = await Promise.race([this.exited, timedOut]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    if (outcome !== "timeout") {
      return outcome;
    }

    this.killFallbackUsed = true;
    this.child.kill("SIGKILL");
    const code = await this.exited;
    throw new Error(
      `MCP CLI did not exit within ${CLOSE_TIMEOUT_MS}ms of stdin end; sent SIGKILL (exit ${String(code)})`,
    );
  }

  /** Best-effort cleanup for `afterEach`; never throws. */
  async dispose(): Promise<void> {
    try {
      await this.close();
    } catch {
      // A failed cleanup must not mask the test's own failure.
    }
  }

  /** Write one newline-delimited JSON message to stdin. */
  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Consume a stdout chunk, buffering any partial trailing line. */
  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.handleStdoutLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  /** Flush a final line that arrived without a trailing newline. */
  private flushStdoutBuffer(): void {
    if (this.stdoutBuffer.length > 0) {
      this.handleStdoutLine(this.stdoutBuffer);
      this.stdoutBuffer = "";
    }
  }

  /** Parse (or record the failure of) one stdout line, then dispatch it. */
  private handleStdoutLine(line: string): void {
    if (line.trim() === "") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.nonJsonStdout.push(line);
      return;
    }
    this.stdoutLines.push(parsed);
    this.dispatch(parsed);
  }

  /** Route a parsed JSON-RPC message to its pending request. */
  private dispatch(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const record = message as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "number") {
      return; // Server-initiated notification/request; nothing to resolve.
    }

    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);

    const error = record["error"];
    if (error !== undefined) {
      const rpc = error as Partial<RpcError>;
      const messageText =
        typeof rpc.message === "string" ? rpc.message : JSON.stringify(error);
      const code = typeof rpc.code === "number" ? rpc.code : "unknown";
      pending.reject(new Error(`JSON-RPC error ${String(code)}: ${messageText}`));
      return;
    }

    pending.resolve(record["result"]);
  }

  /** Reject every outstanding request (used on process exit/spawn failure). */
  private rejectPending(reason: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(reason);
    }
  }

  /** Resolve/reject stderr waiters after new stderr text arrives. */
  private checkStderrWaiters(): void {
    for (const waiter of [...this.stderrWaiters]) {
      if (!waiter.pattern.test(this.stderrBuffer)) {
        continue;
      }
      clearTimeout(waiter.timer);
      const index = this.stderrWaiters.indexOf(waiter);
      if (index !== -1) {
        this.stderrWaiters.splice(index, 1);
      }
      waiter.resolve();
    }
  }

  /** Fail all stderr waiters (used on exit). */
  private failStderrWaiters(reason: Error): void {
    for (const waiter of this.stderrWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  }

  /** Error describing an unexpected/exited child. */
  private exitedError(): Error {
    if (this.spawnFailure !== null) {
      return this.spawnFailure;
    }
    const signal = this.exitSignal === null ? "" : `, signal ${this.exitSignal}`;
    const stderr = this.stderrBuffer.trim();
    return new Error(
      `MCP CLI exited (code ${String(this.exitCode)}${signal})${stderr === "" ? "" : `;\nstderr:\n${stderr}`}`,
    );
  }
}
