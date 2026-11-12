# Changelog

## 0.1.0

First public release.

- `apibear` CLI: serve any OpenAPI 3.0/3.1 document (JSON or YAML, file or URL) as MCP tools over stdio, with header injection (`${VAR}` expansion), `--only`, `--base-url`, `--timeout`, and `--list-tools`.
- Library entry (`import { parseOpenApiToTools, toMcpTool } from "apibear"`): the environment-agnostic parser, formerly published as `@apibear/core` (now deprecated in favor of this package).
