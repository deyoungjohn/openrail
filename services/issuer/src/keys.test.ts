import { describe, expect, it } from "vitest";
import { checkKeyPermissions } from "./keys.js";
import type { KeyInfo, KeyInspector } from "./types.js";

class FakeInspector implements KeyInspector {
  constructor(
    private readonly issuer: KeyInfo | Error,
    private readonly relay: KeyInfo | Error,
  ) {}

  async keyInfo(_accountId: string, publicKey: string): Promise<KeyInfo> {
    const value = publicKey === "issuer-pk" ? this.issuer : this.relay;
    if (value instanceof Error) throw value;
    return value;
  }
}

const GOOD_ISSUER: KeyInfo = {
  kind: "FunctionCall",
  methods: ["log_quote", "issue_for"],
  allowance: "1000000000000000000000000",
};
const GOOD_RELAY: KeyInfo = {
  kind: "FunctionCall",
  methods: ["acknowledge_evm"],
  allowance: "500000000000000000000000",
};

describe("issuer key self-check", () => {
  it("accepts exactly the allowed methods (order-insensitive)", async () => {
    const result = await checkKeyPermissions(
      new FakeInspector(GOOD_ISSUER, GOOD_RELAY),
      "issuer.near",
      "issuer-pk",
      "relay-pk",
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("refuses a full-access issuer key", async () => {
    const result = await checkKeyPermissions(
      new FakeInspector({ kind: "FullAccess", methods: [], allowance: null }, GOOD_RELAY),
      "issuer.near",
      "issuer-pk",
      "relay-pk",
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("full-access");
  });

  it("refuses an issuer key that allows every method", async () => {
    const result = await checkKeyPermissions(
      new FakeInspector({ kind: "FunctionCall", methods: [], allowance: "1" }, GOOD_RELAY),
      "issuer.near",
      "issuer-pk",
      "relay-pk",
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("every method");
  });

  it("refuses a relay key with the wrong method set", async () => {
    const result = await checkKeyPermissions(
      new FakeInspector(GOOD_ISSUER, {
        kind: "FunctionCall",
        methods: ["issue_for"],
        allowance: "1",
      }),
      "issuer.near",
      "issuer-pk",
      "relay-pk",
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("relay key allows");
  });

  it("fails closed when the key query fails", async () => {
    const result = await checkKeyPermissions(
      new FakeInspector(new Error("UNKNOWN_KEY"), GOOD_RELAY),
      "issuer.near",
      "issuer-pk",
      "relay-pk",
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("UNKNOWN_KEY");
  });
});
