import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  getEnv,
  redact,
  redactString,
  registerSecret,
  requireBool,
  requireEnv,
  requireInt,
  resetSecretsForTests,
} from "./index.js";

const JWT = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiJ0ZXN0In0", "c2ln" + "bmF0dXJl"].join(".");
const ED25519 = "ed25519:" + "1".repeat(88);
const LONG_HEX = "0x" + "ab".repeat(32);
const ENV_SECRET = "env-value-" + "s3cr3t".repeat(2);

afterEach(() => {
  delete process.env.OPENRAIL_TEST_REQUIRED;
  delete process.env.OPENRAIL_TEST_SECRET;
  delete process.env.OPENRAIL_TEST_INT;
  delete process.env.OPENRAIL_TEST_BOOL;
  resetSecretsForTests();
  vi.restoreAllMocks();
});

describe("required and typed getters", () => {
  it("requireEnv exits with MISSING_ENV: <NAME> when the variable is absent", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    expect(() => requireEnv("OPENRAIL_TEST_REQUIRED")).toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(writes.join("")).toContain("MISSING_ENV: OPENRAIL_TEST_REQUIRED");
  });

  it("getEnv treats an empty string as missing; requireEnv returns the value", () => {
    process.env.OPENRAIL_TEST_REQUIRED = "value";
    expect(getEnv("OPENRAIL_TEST_REQUIRED")).toBe("value");
    expect(requireEnv("OPENRAIL_TEST_REQUIRED")).toBe("value");
    process.env.OPENRAIL_TEST_REQUIRED = "";
    expect(getEnv("OPENRAIL_TEST_REQUIRED")).toBeUndefined();
  });

  it("requireInt parses an integer and rejects a non-integer", () => {
    process.env.OPENRAIL_TEST_INT = "42";
    expect(requireInt("OPENRAIL_TEST_INT")).toBe(42);
    process.env.OPENRAIL_TEST_INT = "4.2";
    expect(() => requireInt("OPENRAIL_TEST_INT")).toThrow("ENV_INVALID: OPENRAIL_TEST_INT");
  });

  it("requireBool accepts yes/no and true/false, rejecting other values", () => {
    process.env.OPENRAIL_TEST_BOOL = "yes";
    expect(requireBool("OPENRAIL_TEST_BOOL")).toBe(true);
    process.env.OPENRAIL_TEST_BOOL = "false";
    expect(requireBool("OPENRAIL_TEST_BOOL")).toBe(false);
    process.env.OPENRAIL_TEST_BOOL = "maybe";
    expect(() => requireBool("OPENRAIL_TEST_BOOL")).toThrow("ENV_INVALID: OPENRAIL_TEST_BOOL");
  });
});

describe("redaction", () => {
  it("masks a registered env secret value", () => {
    process.env.OPENRAIL_TEST_SECRET = ENV_SECRET;
    expect(requireEnv("OPENRAIL_TEST_SECRET")).toBe(ENV_SECRET);
    expect(redactString(`before ${ENV_SECRET} after`)).not.toContain(ENV_SECRET);
    expect(redactString(`before ${ENV_SECRET} after`)).toContain("before");
  });

  it("masks an explicitly registered secret value", () => {
    registerSecret("DEMO_SECRET", ENV_SECRET);
    expect(redactString(ENV_SECRET)).not.toContain(ENV_SECRET);
  });

  it("masks a JWT", () => {
    expect(redactString(`token=${JWT}`)).not.toContain(JWT);
  });

  it("masks an ed25519 secret key shape", () => {
    expect(redactString(`key=${ED25519}`)).not.toContain(ED25519);
  });

  it("masks a 32-byte long hex value", () => {
    expect(redactString(`hash=${LONG_HEX}`)).not.toContain(LONG_HEX);
  });

  it("masks each shape inside objects, arrays and errors", () => {
    const error = new Error(`crashed with ${JWT}`);
    const result = redact({
      nested: { secret: ENV_SECRET, key: ED25519, hex: LONG_HEX },
      list: [JWT, "safe"],
      error,
    }) as {
      nested: Record<string, string>;
      list: string[];
      error: { message: string };
    };

    const flattened = JSON.stringify(result);
    expect(flattened).not.toContain(JWT);
    expect(flattened).not.toContain(ED25519);
    expect(flattened).not.toContain(LONG_HEX);
    expect(result.list[1]).toBe("safe");
  });
});

describe("logger", () => {
  it("always writes redacted output", () => {
    registerSecret("DEMO_SECRET", ENV_SECRET);
    const lines: string[] = [];
    const logger = createLogger("svc", (line) => lines.push(line));

    logger.info(`hello ${ENV_SECRET}`, { jwt: JWT });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[svc]");
    expect(lines[0]).not.toContain(ENV_SECRET);
    expect(lines[0]).not.toContain(JWT);
  });
});
