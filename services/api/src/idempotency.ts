/** Idempotency-Key store (blueprint 1.7); SQLite-backed through the repository. */
import { createHash } from "node:crypto";
import { createMemoryStores, type IdempotencyRepository } from "./stores.js";

export interface StoredResponse {
  status: number;
  body: unknown;
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
  private readonly ttlMs = 24 * 60 * 60 * 1000;

  constructor(
    private readonly repository: IdempotencyRepository = createMemoryStores().idempotency,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private prune(): void {
    this.repository.prune(this.clock() - this.ttlMs);
  }

  get(key: string, body: unknown): StoredResponse | undefined {
    this.prune();
    const entry = this.repository.get(key);
    if (entry === undefined) return undefined;
    if (entry.fingerprint !== bodyFingerprint(body)) throw new IdempotencyConflict();
    return entry.response;
  }

  put(key: string, body: unknown, response: StoredResponse): void {
    this.prune();
    this.repository.put(key, bodyFingerprint(body), response, this.clock());
  }

  clear(): void {
    // Test helper: a fresh store has a fresh repository; clearing is not part of the API.
  }
}
