import { describe, expect, it } from "vitest";
import { AuthStore, hashApiKey } from "./auth.js";
import { createMemoryStores } from "./stores.js";
import { PUBLISHABLE_PREFIX, registerPublishableKey } from "./register-publishable-key.js";

const KEY = `${PUBLISHABLE_PREFIX}abcdefghijklmnopqrstuvwxyz0123456789ABCD`;

describe("registerPublishableKey", () => {
  it("stores only the hash and authenticates as a publishable key with the pay-session scope", () => {
    const stores = createMemoryStores();
    expect(registerPublishableKey(stores.keys, "openrail.near", KEY)).toBe("registered");
    const record = stores.keys.findByHash(hashApiKey(KEY));
    expect(record?.hash).toBe(hashApiKey(KEY));
    expect(JSON.stringify(record)).not.toContain(KEY);
    const auth = new AuthStore(Date.now, 1000, stores);
    const context = auth.authenticate(KEY);
    expect(context.kind).toBe("publishable");
    expect(context.scopes).toEqual(["pay_sessions:create"]);
  });

  it("is idempotent", () => {
    const stores = createMemoryStores();
    registerPublishableKey(stores.keys, "openrail.near", KEY);
    expect(registerPublishableKey(stores.keys, "openrail.near", KEY)).toBe("already_registered");
    expect(stores.keys.list().length).toBe(1);
  });

  it("rejects keys without the publishable prefix, a secret key, and short keys", () => {
    const stores = createMemoryStores();
    expect(() =>
      registerPublishableKey(stores.keys, "openrail.near", "or_sk_live_" + "x".repeat(40)),
    ).toThrow("INVALID_KEY");
    expect(() =>
      registerPublishableKey(stores.keys, "openrail.near", PUBLISHABLE_PREFIX + "short"),
    ).toThrow("INVALID_KEY");
  });
});
