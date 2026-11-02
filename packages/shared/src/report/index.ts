/**
 * Report writer (blueprint 3.5, hard rule 7).
 *
 * The result is computed from thresholds and measurements; there is no setter
 * and a caller-supplied result is rejected. Every value is redacted before it
 * reaches disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDryRun, redactDeep } from "../env/index.js";

export type ReportResult = "PASS" | "FAIL" | "ERROR" | "SKIPPED" | "PENDING";
export type ReportNetwork = "mainnet" | "testnet" | "sandbox";
export type ThresholdOp = ">=" | "<=" | "==" | "!=" | ">" | "<" | "in";

export interface Threshold {
  path: string;
  op: ThresholdOp;
  value: unknown;
}

export interface ReportTx {
  chain: string;
  hash: string;
  purpose: string;
}

export interface Report {
  test_id: string;
  spec_ref: string;
  tier: string;
  network: ReportNetwork;
  started_utc: string;
  finished_utc: string;
  dry_run: boolean;
  result: ReportResult;
  thresholds: Threshold[];
  measurements: Record<string, unknown>;
  tx: ReportTx[];
  observations: string[];
  fallback_triggered: string | null;
  spend_usd: number;
}

export interface ReportInput {
  test_id: string;
  spec_ref: string;
  tier: string;
  network: ReportNetwork;
  started_utc?: string;
  finished_utc?: string;
  dry_run?: boolean;
  thresholds: Threshold[];
  measurements: Record<string, unknown>;
  tx?: ReportTx[];
  observations?: string[];
  fallback_triggered?: string | null;
  spend_usd?: number;
}

export interface WriteReportOptions {
  reportsDir?: string;
}

const DEFAULT_REPORTS_DIR = fileURLToPath(new URL("../../../../reports/", import.meta.url));

/** ISO UTC without milliseconds. */
export function utcIsoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Filesystem-safe UTC stamp: 2026-11-02T10-20-30Z. */
export function utcStamp(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
}

function fail(message: string): never {
  throw new Error(`REPORT_INVALID: ${message}`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
  return value;
}

function resolvePath(measurements: Record<string, unknown>, path: string): unknown {
  let current: unknown = measurements;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compare(measured: unknown, op: ThresholdOp, expected: unknown): boolean {
  if (op === "in") {
    if (!Array.isArray(expected)) fail("threshold 'in' needs an array value");
    return expected.includes(measured);
  }
  if (op === "==") return measured === expected;
  if (op === "!=") return measured !== expected;
  if (typeof measured !== "number" || typeof expected !== "number") {
    fail(`threshold '${op}' needs numeric values`);
  }
  switch (op) {
    case ">=":
      return measured >= expected;
    case "<=":
      return measured <= expected;
    case ">":
      return measured > expected;
    case "<":
      return measured < expected;
    default:
      return fail(`unknown threshold operator: ${String(op)}`);
  }
}

/**
 * PASS when every threshold holds, FAIL when one does not, ERROR when a
 * measurement is missing or a comparison is impossible.
 */
export function computeResult(
  thresholds: Threshold[],
  measurements: Record<string, unknown>,
): ReportResult {
  if (thresholds.length === 0) return "ERROR";
  let failed = false;
  try {
    for (const threshold of thresholds) {
      const measured = resolvePath(measurements, threshold.path);
      if (measured === undefined) return "ERROR";
      if (!compare(measured, threshold.op, threshold.value)) failed = true;
    }
  } catch {
    return "ERROR";
  }
  return failed ? "FAIL" : "PASS";
}

/** Build and write `reports/<run>-<UTC>.json`; returns the path and redacted report. */
export function writeReport(
  input: ReportInput,
  options: WriteReportOptions = {},
): { path: string; report: Report } {
  if (input !== null && typeof input === "object" && "result" in input) {
    fail("result is computed from thresholds and measurements; it cannot be set");
  }

  const testId = requireString(input.test_id, "test_id").replace(/[^A-Za-z0-9._-]/g, "-");
  const specRef = requireString(input.spec_ref, "spec_ref");
  const tier = requireString(input.tier, "tier");
  if (!Array.isArray(input.thresholds)) fail("thresholds must be an array");
  if (input.measurements === null || typeof input.measurements !== "object") {
    fail("measurements must be an object");
  }

  const spendUsd = input.spend_usd ?? 0;
  if (typeof spendUsd !== "number" || !Number.isFinite(spendUsd) || spendUsd < 0) {
    fail("spend_usd must be a non-negative number");
  }

  const networks: ReportNetwork[] = ["mainnet", "testnet", "sandbox"];
  const network = requireString(input.network, "network") as ReportNetwork;
  if (!networks.includes(network)) fail(`network must be one of ${networks.join(" | ")}`);

  const result = computeResult(input.thresholds, input.measurements);
  const report: Report = {
    test_id: testId,
    spec_ref: specRef,
    tier,
    network,
    started_utc: input.started_utc ?? utcIsoNow(),
    finished_utc: input.finished_utc ?? utcIsoNow(),
    dry_run: input.dry_run ?? isDryRun(),
    result,
    thresholds: input.thresholds,
    measurements: input.measurements,
    tx: input.tx ?? [],
    observations: input.observations ?? [],
    fallback_triggered: input.fallback_triggered ?? null,
    spend_usd: spendUsd,
  };

  const redacted = redactDeep(report);
  const reportsDir = options.reportsDir ?? DEFAULT_REPORTS_DIR;
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
  const path = `${reportsDir}${reportsDir.endsWith("/") ? "" : "/"}${testId}-${utcStamp()}.json`;
  writeFileSync(path, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  return { path, report: redacted };
}

/** Read a written report back. */
export function readReport(path: string): Report {
  return JSON.parse(readFileSync(path, "utf8")) as Report;
}
