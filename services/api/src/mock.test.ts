import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_FIXTURES_URL, createMockServer, loadManifest, loadSpec } from "./mock.js";

let server: Server;
let baseUrl: string;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, API_FIXTURES_URL), "utf8")) as unknown;
}

beforeAll(async () => {
  server = createMockServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

describe("MOCK=1 API", () => {
  it("serves the OpenAPI document", async () => {
    const response = await fetch(`${baseUrl}/v1/openapi.json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { openapi: string };
    expect(body).toEqual(loadSpec());
    expect(body.openapi).toBe("3.1.0");
  });

  it("serves every manifest mock fixture at its route", async () => {
    const manifest = loadManifest();
    for (const entry of manifest.fixtures.filter((candidate) => candidate.mock)) {
      const path = entry.path.replace(/\{[^}]+\}/g, "sample");
      const response = await fetch(`${baseUrl}${path}`, { method: entry.method });
      expect(response.status, `${entry.method} ${path}`).toBe(entry.status);
      expect(await response.json(), entry.file).toEqual(fixture(entry.file));
    }
  });

  it("returns the documented 404 shape for an unknown route", async () => {
    const response = await fetch(`${baseUrl}/v1/not-a-route`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual(fixture("error.404.json"));
  });

  it("answers CORS preflight with the exact web origin and credentials", async () => {
    process.env.WEB_ORIGIN = "http://localhost:3000";
    const response = await fetch(`${baseUrl}/v1/invoices`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-headers")).toContain("idempotency-key");

    const other = await fetch(`${baseUrl}/v1/invoices`, {
      method: "OPTIONS",
      headers: { origin: "http://evil.example" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    delete process.env.WEB_ORIGIN;
  });
});
