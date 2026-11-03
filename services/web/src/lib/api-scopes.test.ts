import { describe, expect, it } from "vitest";
import { API_KEY_SCOPES, DEFAULT_SCOPES, scopesProblem } from "./api-scopes";

describe("secret key scopes (SQ-14)", () => {
  it("are exactly these five, in this order", () => {
    expect(API_KEY_SCOPES).toEqual([
      "invoices:read",
      "invoices:write",
      "payments:read",
      "receipts:read",
      "webhooks:write",
    ]);
  });
  it("a new key has all five by default", () => {
    expect(DEFAULT_SCOPES).toEqual([...API_KEY_SCOPES]);
  });
  it("needs at least one scope and only known ones", () => {
    expect(scopesProblem([])).not.toBeNull();
    expect(scopesProblem(["invoices:read"])).toBeNull();
    expect(scopesProblem(["invoices:read", "pay_sessions:create"])).not.toBeNull();
  });
});
