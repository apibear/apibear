<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-lockup-dark.svg">
    <img alt="API Bear" src=".github/assets/logo-lockup-light.svg" width="274" height="64">
  </picture>
</p>

# apibear

Turn any OpenAPI 3.0 or 3.1 specification into Model Context Protocol (MCP) tools over stdio for Claude Desktop, Cursor, Claude Code, OpenCode, Kiro, VS Code, Windsurf, and any MCP client.

[![npm version](https://img.shields.io/npm/v/apibear.svg)](https://www.npmjs.com/package/apibear)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 18.17](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/apibear/apibear/actions/workflows/ci.yml/badge.svg)](https://github.com/apibear/apibear/actions/workflows/ci.yml)

`apibear` inspects an OpenAPI document (JSON or YAML, local file or URL), generates clean MCP tool definitions with typed input schemas, and serves those tools over standard I/O. When an AI assistant invokes a tool, `apibear` executes the corresponding HTTP request against the upstream API with your authentication headers.

The same package also exports the parser as a [library](#-library-usage) that runs in Node, browsers, and edge runtimes.

---

## Quick Start

Run instantly with `npx` (no installation required):

```bash
npx -y apibear --spec https://petstore3.swagger.io/api/v3/openapi.json
```

Or test tool extraction without launching a server:

```bash
npx -y apibear --spec https://petstore3.swagger.io/api/v3/openapi.json --list-tools
```

Output:
```text
listPets - List all pets
createPet - Create a pet
showPetById - Info for a specific pet
```

---

## Client Configurations

### 1. Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": [
        "-y",
        "apibear",
        "--spec",
        "https://api.example.com/openapi.json",
        "--header",
        "Authorization: Bearer YOUR_TOKEN"
      ]
    }
  }
}
```

### 2. Cursor

Add to `.cursor/mcp.json` or Cursor Settings → Features → MCP:

```json
{
  "mcpServers": {
    "api": {
      "command": "npx",
      "args": [
        "-y",
        "apibear",
        "--spec",
        "./openapi.yaml",
        "--header",
        "X-API-Key: YOUR_KEY"
      ]
    }
  }
}
```

### 3. Claude Code CLI

Add directly from your terminal:

```bash
claude mcp add my-api -- npx -y apibear \
  --spec https://api.example.com/openapi.json \
  --header "Authorization: Bearer YOUR_TOKEN"
```

### 4. OpenCode / Zed

```json
{
  "command": ["npx", "-y", "apibear", "--spec", "https://api.example.com/openapi.json"]
}
```

### 5. Kiro

Add to `.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (global):

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": [
        "-y",
        "apibear",
        "--spec", "https://api.example.com/openapi.json",
        "--header", "Authorization: Bearer YOUR_TOKEN"
      ]
    }
  }
}
```

### 6. VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "my-api": {
      "command": "npx",
      "args": [
        "-y",
        "apibear",
        "--spec", "https://api.example.com/openapi.json",
        "--header", "Authorization: Bearer YOUR_TOKEN"
      ]
    }
  }
}
```

### 7. Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": [
        "-y",
        "apibear",
        "--spec", "https://api.example.com/openapi.json",
        "--header", "Authorization: Bearer YOUR_TOKEN"
      ]
    }
  }
}
```

---

## CLI Reference

```text
Usage: apibear --spec <path|url> [options]
```

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--spec <path\|url>` | **Required** | OpenAPI 3.x document (JSON or YAML) as a local file path or `http(s)://` URL. |
| `--header <Name:Value>` | Optional | Header injected into upstream requests. Repeatable (e.g. `--header "Authorization: Bearer xyz"`). `${VAR}` in the value is read from the environment; `$${` is a literal `${`. |
| `--only <id,id,...>` | Optional | Comma-separated original `operationId`s to expose. Omits all other endpoints to save LLM context window tokens. |
| `--base-url <url>` | Optional | Override the base URL defined in the spec. Mandatory when the spec omits a server URL. |
| `--timeout <ms>` | Optional | HTTP request timeout in milliseconds (default: `30000`). |
| `--list-tools` | Flag | Lists discovered tools (`name - description`) to stdout and exits `0` without starting the server. |
| `-h`, `--help` | Flag | Print usage information and exit `0`. In an interactive terminal at least 60 columns wide, an ASCII bear banner comes first; piped output stays plain. |
| `--version` | Flag | Print current package version and exit `0`. |

### Keeping tokens out of client config

MCP clients pass `args` to `apibear` without a shell, so `apibear` expands `${VAR}` in `--header` values itself. Put the secret in the client's `env` block (or your environment) and refer to it:

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": ["-y", "apibear", "--spec", "https://api.example.com/openapi.json",
               "--header", "Authorization: Bearer ${MY_API_TOKEN}"],
      "env": { "MY_API_TOKEN": "sk-..." }
    }
  }
}
```

If a referenced variable is unset or empty, `apibear` exits with code `2` and names the variable, never the value.

---

## Library Usage

```bash
npm install apibear
```

The library entry (`import ... from "apibear"`) is environment-agnostic: no Node-only APIs (`fs`, `path`, `fetch`) and no runtime dependencies are pulled in, so it runs in Node.js >= 18.17, browsers, Cloudflare Workers, Deno, and Bun. The CLI is a separate entry point, so importing the library never loads it.

```ts
import { parseOpenApiToTools, toMcpTool } from "apibear";

// 1. Pass in your parsed OpenAPI 3.0 / 3.1 object
const { tools, api, warnings } = parseOpenApiToTools(openApiDocument);

// 2. Project tools for the MCP wire protocol (strips internal HTTP execution plans)
const wireTools = tools.map(toMcpTool);
// wireTools = [{ name: "listPets", description: "List all pets", inputSchema: { ... } }]

// 3. Access execution metadata (for HTTP clients / runners)
const plan = tools[0].metadata;
// { method: "get", pathTemplate: "/pets", baseUrl: "https://api.example.com", parameters: [...] }
```

---

### Data Contract

```ts
interface ParseResult {
  tools: ParsedTool[];
  api: {
    title: string;
    version: string;
    baseUrl: string | null;
  };
  warnings: ParserWarning[];
}

interface ParsedTool {
  name: string;            // Sanitized & deduplicated (matches /^[a-zA-Z0-9_-]{1,64}$/)
  description?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  metadata: ToolMetadata;  // Execution plan (method, pathTemplate, params, headers)
}
```

### Filtering Tools

Pass an optional filter to extract only a subset of operations:

```ts
const { tools } = parseOpenApiToTools(spec, {
  filter: ["listPets", "getPetById"] // filters by original operationId
});
```

---

## Development

```bash
git clone https://github.com/apibear/apibear.git
cd apibear
npm install
npm test            # builds dist/ and runs the full suite (Node 22+ for tooling)
npm run typecheck

# Run the CLI from the build output
node dist/cli.js --spec test/cli/fixtures/petstore.json --list-tools
```

Layout: `src/core/` is the environment-agnostic parser (the library entry, `src/index.ts`); `src/cli/` is the stdio MCP server and `apibear` bin.

---

## Security & Logging

- **Zero Stdout Pollution:** Standard output (`stdout`) is strictly reserved for the MCP JSON-RPC protocol stream. All diagnostics, status messages, and warnings are routed to `stderr`.
- **Secret Redaction:** `--header` argument values (tokens, secrets) are redacted from logs; only header names are printed.
- **Pre-flight Input Validation:** Required parameters and payload formats are validated before dispatching upstream requests.
- **Redirect Safety:** Up to 5 redirects are followed. Once a redirect leaves the original origin, every `--header` value and the `Authorization`/`Cookie` headers are dropped, so API keys are never sent to another host.
- **Bounded Responses:** At most ~1 MB of each upstream response is read, and at most 256,000 characters go to the model. Images come back as MCP image content; other binary bodies are summarized rather than decoded.
- **Cancellation:** When the MCP client cancels a tool call, the upstream request is aborted too.

---

## Issues & Security

Bugs and feature requests: [GitHub issues](https://github.com/apibear/apibear/issues). Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

---

## License

MIT © 2026 API Bear
