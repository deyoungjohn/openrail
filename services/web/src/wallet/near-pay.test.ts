import { describe, expect, it } from "vitest";
import { nearTokenPayment, NEAR_TOKEN_STORAGE_YOCTO } from "./near-pay";

describe("a NEAR token payment from the connected wallet", () => {
  it("registers the deposit address with the token, then transfers (one transaction)", () => {
    const calls = nearTokenPayment("ab".repeat(32), 2_000_000n, "usdt.tether-token.near");
    expect(calls.map((c) => c.methodName)).toEqual(["storage_deposit", "ft_transfer"]);
    expect(calls[0]?.deposit).toBe(NEAR_TOKEN_STORAGE_YOCTO);
    expect(calls[1]).toMatchObject({ args: { amount: "2000000" }, deposit: "1" });
  });
  it("wraps native NEAR first", () => {
    const calls = nearTokenPayment("ab".repeat(32), 10n ** 24n, "wrap.near", "payer.near");
    expect(calls.map((c) => c.methodName)).toEqual([
      "storage_deposit",
      "near_deposit",
      "storage_deposit",
      "ft_transfer",
    ]);
    expect(calls[1]?.deposit).toBe((10n ** 24n).toString());
    expect(calls[0]?.args).toEqual({ account_id: "payer.near", registration_only: true });
  });
});
