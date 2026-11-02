/**
 * Minimal JSON Schema validator for the OpenAPI 3.1 fixture contract test.
 *
 * Supports the subset used by services/api/openapi.json: $ref, type (including
 * type arrays), const, enum, oneOf/anyOf/allOf, object properties/required,
 * additionalProperties, array items and the common string/number bounds.
 * `format` is structural documentation here, not an assertion.
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  const?: JsonValue;
  enum?: JsonValue[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function typeMatches(value: JsonValue, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

export function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  const parts = ref.replace(/^#\//, "").split("/");
  let current: unknown = root;
  for (const raw of parts) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as JsonSchema | undefined;
}

/** Return human-readable issues; an empty array means the value validates. */
export function validate(
  value: JsonValue,
  schema: JsonSchema,
  root: JsonSchema,
  path = "$",
): string[] {
  if (schema.$ref !== undefined) {
    const target = resolveRef(schema.$ref, root);
    if (target === undefined) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validate(value, target, root, path);
  }

  if (schema.nullable === true && value === null) return [];
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    return [`${path}: expected const ${JSON.stringify(schema.const)}`];
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => deepEqual(value, entry))) {
    return [`${path}: not in enum`];
  }

  if (schema.oneOf !== undefined) {
    const passing = schema.oneOf.filter(
      (branch) => validate(value, branch, root, path).length === 0,
    );
    if (passing.length !== 1) return [`${path}: matched ${passing.length} oneOf branches`];
  }
  if (schema.anyOf !== undefined) {
    const passing = schema.anyOf.some((branch) => validate(value, branch, root, path).length === 0);
    if (!passing) return [`${path}: matched no anyOf branch`];
  }
  if (schema.allOf !== undefined) {
    const issues = schema.allOf.flatMap((branch) => validate(value, branch, root, path));
    if (issues.length > 0) return issues;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      return [`${path}: expected type ${types.join("|")}`];
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return [`${path}: shorter than ${schema.minLength}`];
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return [`${path}: longer than ${schema.maxLength}`];
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return [`${path}: does not match ${schema.pattern}`];
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return [`${path}: below minimum ${schema.minimum}`];
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return [`${path}: above maximum ${schema.maximum}`];
    }
  }

  if (Array.isArray(value)) {
    const issues: string[] = [];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        issues.push(...validate(entry, schema.items as JsonSchema, root, `${path}[${index}]`));
      });
    }
    return issues;
  }

  if (value !== null && typeof value === "object") {
    const issues: string[] = [];
    const object = value as Record<string, JsonValue>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) issues.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in object)
        issues.push(...validate(object[key] as JsonValue, child, root, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(object)) {
        if (!known.has(key)) issues.push(`${path}.${key}: additional property`);
      }
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, entry] of Object.entries(object)) {
        if (!known.has(key)) {
          issues.push(
            ...validate(entry, schema.additionalProperties as JsonSchema, root, `${path}.${key}`),
          );
        }
      }
    }
    return issues;
  }

  return [];
}
