/**
 * Library entry for `apibear`.
 *
 * Re-exports the environment-agnostic OpenAPI -> MCP parser in `./core`. Safe
 * to import in Node, browsers, and edge runtimes: it pulls in none of the
 * CLI's dependencies. The `apibear` command lives in `./cli/cli.ts`.
 */
export * from "./core/index.js";
