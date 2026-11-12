#!/usr/bin/env node
/**
 * CLI entry point (bin).
 *
 * Order: parse args -> load spec -> build tools -> (list tools | serve over
 * stdio). STDOUT IS THE MCP TRANSPORT; the only non-protocol stdout output is
 * `--help`, `--version`, and the `--list-tools` listing. Every diagnostic goes
 * to stderr via `./logger.js`.
 */

import type { ParsedTool } from "../core/index.js";

import { parseCliArgs } from "./args.js";
import type { RunnerOptions } from "./args.js";
import { renderBanner, shouldShowBanner } from "./banner.js";
import { UsageError } from "./errors.js";
import { error as logError, log, warn } from "./logger.js";
import { startServer } from "./server.js";
import { loadSpec } from "./spec.js";
import { buildTools } from "./tools.js";
import { VERSION } from "./version.js";

/** Longest tool description shown by `--list-tools`, before the ellipsis. */
const MAX_LIST_DESCRIPTION = 100;

/**
 * First line of a description with runs of whitespace collapsed to one space.
 * Returns an empty string when there is no usable description.
 */
function oneLineDescription(description: string | undefined): string {
  if (description === undefined) {
    return "";
  }
  const firstLine = description.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.replace(/\s+/g, " ").trim();
}

/** Format one `--list-tools` line: `name - description` (or just the name). */
function formatToolLine(tool: ParsedTool): string {
  const description = oneLineDescription(tool.description);
  if (description.length === 0) {
    return tool.name;
  }
  const shown =
    description.length > MAX_LIST_DESCRIPTION
      ? `${description.slice(0, MAX_LIST_DESCRIPTION)}…`
      : description;
  return `${tool.name} - ${shown}`;
}

/** Print the tool listing to stdout (the permitted non-protocol output). */
function printToolList(tools: ParsedTool[]): void {
  let out = "";
  for (const tool of tools) {
    out += `${formatToolLine(tool)}\n`;
  }
  process.stdout.write(out);
}

/** Strip trailing slashes from a user-supplied base URL. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Execute a `run` invocation: load, optionally list, otherwise serve. */
async function run(options: RunnerOptions): Promise<number> {
  const doc = await loadSpec(options.spec);
  const loaded = buildTools(doc, options.only, options.spec);

  if (options.baseUrl === undefined) {
    const missing = loaded.tools.filter((tool) => tool.metadata.baseUrl === null).length;
    if (missing > 0) {
      warn(
        `${missing} of ${loaded.tools.length} tools have no usable server URL in the spec; calls to them will fail unless you pass --base-url`,
      );
    }
  }

  if (options.listTools) {
    printToolList(loaded.tools);
    return 0;
  }

  await startServer({
    loaded,
    headers: options.headers,
    ...(options.baseUrl === undefined ? {} : { baseUrl: normalizeBaseUrl(options.baseUrl) }),
    timeoutMs: options.timeoutMs,
  });
  return 0;
}

/** Map an uncaught failure to the documented exit code (2 usage, 1 runtime). */
function reportFailure(thrown: unknown): number {
  if (thrown instanceof UsageError) {
    logError(thrown.message);
    return 2;
  }

  const message = thrown instanceof Error ? thrown.message : String(thrown);
  logError(message);
  if (process.env.APIBEAR_DEBUG !== undefined && process.env.APIBEAR_DEBUG !== "") {
    if (thrown instanceof Error && thrown.stack !== undefined) {
      logError(thrown.stack);
    }
  }
  return 1;
}

/** Program entry; returns the exit code instead of calling `process.exit`. */
async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseCliArgs(argv);

    if (parsed.kind === "help") {
      const banner = shouldShowBanner(process.stdout) ? `${renderBanner(VERSION)}\n\n` : "";
      process.stdout.write(`${banner}${parsed.text}\n`);
      return 0;
    }

    if (parsed.kind === "version") {
      process.stdout.write(`${parsed.text}\n`);
      return 0;
    }

    if (parsed.kind === "error") {
      logError(parsed.message);
      log("run with --help for usage");
      return 2;
    }

    return await run(parsed.options);
  } catch (thrown) {
    return reportFailure(thrown);
  }
}

process.on("unhandledRejection", (reason) => {
  logError(reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});

process.on("uncaughtException", (thrown) => {
  logError(thrown.message);
  process.exit(1);
});

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
