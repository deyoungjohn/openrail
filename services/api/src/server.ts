/**
 * Entrypoint. MOCK=1 serves fixtures; otherwise the real S1b API runs.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createApiAppFromEnv } from "./defaults.js";
import { createMockServer } from "./mock.js";

const port = Number(process.env.API_PORT ?? 8787);

function cors(request: IncomingMessage, response: ServerResponse): void {
  const allowed = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const origin = request.headers.origin;
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization,content-type,idempotency-key");
  if (origin !== undefined && origin === allowed) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
  }
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  if (process.env.MOCK === "1") {
    const server = createMockServer();
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`MOCK API listening on http://127.0.0.1:${port}\n`);
    });
    return;
  }

  const app = await createApiAppFromEnv();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      cors(request, response);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, mock: false }));
        return;
      }
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = Array.isArray(value) ? value.join(",") : value;
      }
      const result = await app.handle({
        method: request.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers,
        body: await bodyOf(request),
      });
      response.writeHead(result.status, {
        "content-type": "application/json; charset=utf-8",
        ...(result.headers ?? {}),
      });
      response.end(JSON.stringify(result.body));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "internal_error", message: "internal error" } }),
      );
      void error;
    });
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`API listening on http://127.0.0.1:${port}\n`);
  });
}

void main();
