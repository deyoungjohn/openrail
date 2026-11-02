/**
 * MOCK=1 API server: serves the recorded-shape fixtures in fixtures/api/ so the
 * UI can build screens before the real backend exists (P0.5/S1a contract).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FixtureEntry {
  file: string;
  method: string;
  path: string;
  status: number;
  schema: string;
  mock: boolean;
}

export interface FixtureManifest {
  fixtures: FixtureEntry[];
}

export const SPEC_URL = new URL("../openapi.json", import.meta.url);
export const API_FIXTURES_URL = new URL("../../../fixtures/api/", import.meta.url);

export function loadSpec(): Record<string, unknown> {
  return JSON.parse(readFileSync(SPEC_URL, "utf8")) as Record<string, unknown>;
}

export function loadManifest(fixturesUrl: URL = API_FIXTURES_URL): FixtureManifest {
  return JSON.parse(readFileSync(new URL("manifest.json", fixturesUrl), "utf8")) as FixtureManifest;
}

function pathMatches(template: string, actual: string): boolean {
  const expected = template.split("/");
  const received = actual.split("/");
  if (expected.length !== received.length) return false;
  return expected.every((segment, index) => {
    if (segment.startsWith("{") && segment.endsWith("}")) return (received[index] ?? "") !== "";
    return segment === received[index];
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, fixture?: string): void {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,idempotency-key",
  };
  if (fixture !== undefined) headers["x-mock-fixture"] = fixture;
  response.writeHead(status, headers);
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

export interface MockServerOptions {
  fixturesUrl?: URL;
  manifest?: FixtureManifest;
  spec?: Record<string, unknown>;
}

/** Create (but do not listen on) the mock API server. */
export function createMockServer(options: MockServerOptions = {}): Server {
  const fixturesUrl = options.fixturesUrl ?? API_FIXTURES_URL;
  const manifest = options.manifest ?? loadManifest(fixturesUrl);
  const spec = options.spec ?? loadSpec();
  const fixtures = new Map<string, { entry: FixtureEntry; body: unknown }>();
  for (const entry of manifest.fixtures.filter((candidate) => candidate.mock)) {
    fixtures.set(entry.file, {
      entry,
      body: JSON.parse(readFileSync(new URL(entry.file, fixturesUrl), "utf8")) as unknown,
    });
  }
  const notFound = JSON.parse(
    readFileSync(new URL("error.404.json", fixturesUrl), "utf8"),
  ) as unknown;

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = (request.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,idempotency-key",
      });
      response.end();
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://mock.local").pathname;
    if (method === "GET" && pathname === "/v1/openapi.json") {
      sendJson(response, 200, spec, "openapi.json");
      return;
    }
    if (method === "GET" && pathname === "/health") {
      sendJson(response, 200, { ok: true, mock: true });
      return;
    }

    for (const { entry, body } of fixtures.values()) {
      if (entry.method === method && pathMatches(entry.path, pathname)) {
        sendJson(response, entry.status, body, entry.file);
        return;
      }
    }
    sendJson(response, 404, notFound, "error.404.json");
  });
}
