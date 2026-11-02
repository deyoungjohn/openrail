import { describe, expect, it } from "vitest";
import { IdempotencyConflict, IdempotencyStore, bodyFingerprint } from "./idempotency.js";

describe("idempotency store", () => {
  it("returns the first response for the same key and body", () => {
    const store = new IdempotencyStore();
    store.put("key-1", { a: 1, b: 2 }, { status: 201, body: { id: "inv_1" } });
    expect(store.get("key-1", { b: 2, a: 1 })).toEqual({ status: 201, body: { id: "inv_1" } });
  });

  it("409s the same key with another body", () => {
    const store = new IdempotencyStore();
    store.put("key-1", { a: 1 }, { status: 201, body: { id: "inv_1" } });
    expect(() => store.get("key-1", { a: 2 })).toThrow(IdempotencyConflict);
  });

  it("fingerprints object key order identically", () => {
    expect(bodyFingerprint({ z: 1, a: [2, { y: 3, b: 4 }] })).toBe(
      bodyFingerprint({ a: [2, { b: 4, y: 3 }], z: 1 }),
    );
  });

  it("ignores unknown keys", () => {
    expect(new IdempotencyStore().get("missing", {})).toBeUndefined();
  });
});
