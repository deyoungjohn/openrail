/** In-memory Idempotency-Key store (blueprint 1.7). */
import { createHash } from "node:crypto";

export interface StoredResponse {
  status: number;
  body: unknown;
}

interface Entry {
  fingerprint: string;
  response: StoredResponse;
}

export class IdempotencyConflict extends Error {
  override readonly name = "IdempotencyConflict";

  constructor() {
    super("IDEMPOTENCY_KEY_REUSE: same key with a different body");
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(",")}}`;
}

export function bodyFingerprint(body: unknown): string {
  return createHash("sha256").update(stable(body)).digest("hex");
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  get(key: string, body: unknown): StoredResponse | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.fingerprint !== bodyFingerprint(body)) throw new IdempotencyConflict();
    return entry.response;
  }

  put(key: string, body: unknown, response: StoredResponse): void {
    this.entries.set(key, { fingerprint: bodyFingerprint(body), response });
  }

  clear(): void {
    this.entries.clear();
  }
}
