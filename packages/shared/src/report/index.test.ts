import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeResult, utcStamp, writeReport, type ReportInput } from "./index.js";

const JWT = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiJ0ZXN0In0", "c2ln" + "bmF0dXJl"].join(
  ".",
);
const EVM_TX_HASH = "0x" + "ab".repeat(32);
const SHA256_HASH = "cd".repeat(32);
const SECRET_HEX = "12".repeat(32);

const dirs: string[] = [];
function reportsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openrail-report-"));
  dirs.push(dir);
  return dir;
}

function baseInput(): ReportInput {
  return {
    test_id: "P0.5-report-test",
    spec_ref: "blueprint 3.5",
    tier: "T1",
    network: "sandbox",
    thresholds: [{ path: "credit", op: ">=", value: 1 }],
    measurements: { credit: 2 },
    tx: [{ chain: "near", hash: "hash-1", purpose: "reconcile" }],
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mechanical result", () => {
  it("returns PASS when every threshold is met", () => {
    expect(computeResult([{ path: "a", op: ">=", value: 1 }], { a: 1 })).toBe("PASS");
  });

  it("returns FAIL when a threshold is not met", () => {
    expect(computeResult([{ path: "a", op: ">=", value: 2 }], { a: 1 })).toBe("FAIL");
  });

  it("returns ERROR when a measured value is missing", () => {
    expect(computeResult([{ path: "missing", op: ">=", value: 1 }], { a: 1 })).toBe("ERROR");
  });

  it("returns ERROR when no thresholds are supplied", () => {
    expect(computeResult([], { a: 1 })).toBe("ERROR");
  });

  it("reads a nested measurement path", () => {
    expect(
      computeResult([{ path: "swap.credit", op: "==", value: "10" }], { swap: { credit: "10" } }),
    ).toBe("PASS");
  });
});

describe("report writer", () => {
  it("computes the result and cannot be given one by the caller", () => {
    const input = { ...baseInput(), result: "PASS" } as unknown as ReportInput;
    expect(() => writeReport(input, { reportsDir: reportsDir() })).toThrow("result is computed");
  });

  it("writes reports/<run>-<UTC>.json with the transaction hashes", () => {
    const dir = reportsDir();
    const { path, report } = writeReport(baseInput(), { reportsDir: dir });

    expect(path.startsWith(dir)).toBe(true);
    expect(path).toMatch(/P0\.5-report-test-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/);
    expect(report.result).toBe("PASS");
    expect(report.tx).toEqual([{ chain: "near", hash: "hash-1", purpose: "reconcile" }]);

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { result: string; tx: unknown[] };
    expect(onDisk.result).toBe("PASS");
    expect(onDisk.tx).toHaveLength(1);
  });

  it("requires a network and rejects an unknown one", () => {
    const missing = baseInput();
    delete (missing as Partial<ReportInput>).network;
    expect(() => writeReport(missing, { reportsDir: reportsDir() })).toThrow("network");

    const invalid = { ...baseInput(), network: "production" } as unknown as ReportInput;
    expect(() => writeReport(invalid, { reportsDir: reportsDir() })).toThrow("network");
  });

  it("keeps EVM transaction, sha256 and code hashes readable on disk", () => {
    const input = baseInput();
    input.tx = [{ chain: "base", hash: EVM_TX_HASH, purpose: "deposit" }];
    input.measurements = { credit: 2, terms_hash: SHA256_HASH, code_hash: SHA256_HASH };
    const { path } = writeReport(input, { reportsDir: reportsDir() });
    const text = readFileSync(path, "utf8");

    expect(text).toContain(EVM_TX_HASH);
    expect(text).toContain(SHA256_HASH);
  });

  it("redacts secrets before writing", () => {
    const input = baseInput();
    input.measurements = { credit: 1, token: JWT, private_key: SECRET_HEX };
    const { path } = writeReport(input, { reportsDir: reportsDir() });
    const text = readFileSync(path, "utf8");

    expect(text).not.toContain(JWT);
    expect(text).not.toContain(SECRET_HEX);
  });

  it("stamps UTC in a filesystem-safe form", () => {
    expect(utcStamp(new Date("2026-11-02T10:20:30.000Z"))).toBe("2026-11-02T10-20-30Z");
  });
});
