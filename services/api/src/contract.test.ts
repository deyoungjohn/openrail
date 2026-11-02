import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveRef, validate, type JsonSchema, type JsonValue } from "./openapi-validate.js";

const SPEC_URL = new URL("../openapi.json", import.meta.url);
const API_FIXTURES = new URL("../../../fixtures/api/", import.meta.url);

interface ManifestEntry {
  file: string;
  method: string;
  path: string;
  status: number;
  schema: string;
  mock: boolean;
}

interface Manifest {
  fixtures: ManifestEntry[];
}

const spec = JSON.parse(readFileSync(SPEC_URL, "utf8")) as {
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<string, { content?: { ["application/json"]?: { schema?: JsonSchema } } }>;
      }
    >
  >;
};
const manifest = JSON.parse(
  readFileSync(new URL("manifest.json", API_FIXTURES), "utf8"),
) as Manifest;

function fixture(name: string): JsonValue {
  return JSON.parse(readFileSync(new URL(name, API_FIXTURES), "utf8")) as JsonValue;
}

describe("OpenAPI document", () => {
  it("resolves every $ref", () => {
    const broken: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === "string") {
        if (resolveRef(record.$ref, spec) === undefined) broken.push(`${path}: ${record.$ref}`);
      }
      for (const [key, entry] of Object.entries(record)) walk(entry, `${path}.${key}`);
    };
    walk(spec, "$");
    expect(broken).toEqual([]);
  });
});

describe("fixtures against the OpenAPI document", () => {
  it("has a manifest entry for every response fixture", () => {
    for (const entry of manifest.fixtures) {
      expect(() => fixture(entry.file), entry.file).not.toThrow();
    }
  });

  it("validates every fixture against the named schema", () => {
    for (const entry of manifest.fixtures) {
      const schema = spec.components.schemas[entry.schema];
      expect(schema, `${entry.file}: schema ${entry.schema}`).toBeDefined();
      if (schema === undefined) throw new Error(`missing schema ${entry.schema}`);
      const issues = validate(fixture(entry.file), schema, spec as unknown as JsonSchema, "$");
      expect(issues, `${entry.file}: ${issues.join("; ")}`).toEqual([]);
    }
  });

  it("maps every fixture to a real operation and response schema", () => {
    for (const entry of manifest.fixtures) {
      const operation = spec.paths[entry.path]?.[entry.method.toLowerCase()];
      expect(operation, `${entry.method} ${entry.path}`).toBeDefined();
      const response = operation?.responses[String(entry.status)];
      expect(response, `${entry.method} ${entry.path} -> ${entry.status}`).toBeDefined();
      const schema = response?.content?.["application/json"]?.schema;
      expect(schema?.$ref, `${entry.file}`).toBe(`#/components/schemas/${entry.schema}`);
    }
  });

  it("has a success fixture for every operation (except the OpenAPI meta route)", () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method] of Object.entries(item)) {
        if (path === "/v1/openapi.json") continue;
        const covered = manifest.fixtures.some(
          (entry) =>
            entry.method === method.toUpperCase() &&
            entry.path === path &&
            entry.status >= 200 &&
            entry.status < 300 &&
            entry.mock,
        );
        if (!covered) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
