/**
 * Tiny `node:http` fixture API for the e2e suite (task 2.6).
 *
 * It binds to `127.0.0.1` on an ephemeral port so the tests perform zero
 * network egress, and it echoes back the path/query/headers it received so the
 * tests can prove what the CLI actually sent upstream.
 */

import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** One request as observed by the fixture server. */
export interface RecordedHit {
  method: string;
  /** Pathname only, e.g. `/pets/42` (no query string). */
  path: string;
  /** Parsed query; repeated keys are arrays. */
  query: Record<string, string | string[]>;
  /** Received headers; Node lowercases names by default. */
  headers: IncomingHttpHeaders;
  /** Parsed JSON body for requests that carried one. */
  body?: unknown;
}

/** A running fixture API. */
export interface FixtureApi {
  port: number;
  baseUrl: string;
  hits: RecordedHit[];
  clear(): void;
  close(): Promise<void>;
  /** The address the HTTP server actually bound to (for the egress guard). */
  address(): AddressInfo;
}

/** Delay helper for the `slow` pet route. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Parse a raw URL's query string; repeated keys become arrays. */
function parseQuery(rawUrl: string): Record<string, string | string[]> {
  const params = new URL(rawUrl, "http://127.0.0.1").searchParams;
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

/** Read a request body as UTF-8 text. */
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Send one JSON response. */
function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Start the fixture API on `127.0.0.1:0`. */
export async function startFixtureApi(): Promise<FixtureApi> {
  const hits: RecordedHit[] = [];

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
    const query = parseQuery(rawUrl);
    const headers = req.headers;

    const hit: RecordedHit = { method, path: pathname, query, headers };

    // GET /pets — list.
    if (method === "GET" && pathname === "/pets") {
      hits.push(hit);
      sendJson(res, 200, { pets: [{ id: "1", name: "Rex" }], query, headers });
      return;
    }

    // POST /pets — create; echo the parsed body.
    if (method === "POST" && pathname === "/pets") {
      const raw = await readBody(req);
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Keep the raw string so a malformed body is still inspectable.
      }
      hits.push({ ...hit, body: parsed });
      sendJson(res, 201, {
        created: parsed,
        contentType: headers["content-type"] ?? null,
        headers,
      });
      return;
    }

    // GET /pets/:id — show, with `missing` and `slow` special cases.
    const showMatch = /^\/pets\/([^/]+)$/.exec(pathname);
    if (method === "GET" && showMatch !== null) {
      const id = decodeURIComponent(showMatch[1] ?? "");
      hits.push(hit);

      if (id === "missing") {
        sendJson(res, 404, { error: "pet not found", id: "missing" });
        return;
      }

      if (id === "slow") {
        await delay(500);
      }

      sendJson(res, 200, { id, name: `Pet ${id}`, path: pathname, query, headers });
      return;
    }

    hits.push(hit);
    sendJson(res, 404, { error: "not found", method, path: pathname });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    server.close();
    throw new Error("fixture API did not bind to a TCP address");
  }

  const host = bound.address;
  if (host !== "127.0.0.1") {
    server.close();
    throw new Error(`fixture API bound to ${host}, expected 127.0.0.1 (network egress guard)`);
  }

  return {
    port: bound.port,
    baseUrl: `http://127.0.0.1:${bound.port}`,
    hits,
    clear(): void {
      hits.length = 0;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // fetch keeps connections alive; drop them so close() cannot hang.
        server.closeAllConnections();
      });
    },
    address(): AddressInfo {
      const current = server.address();
      if (current === null || typeof current === "string") {
        throw new Error("fixture API is not listening");
      }
      return current;
    },
  };
}
