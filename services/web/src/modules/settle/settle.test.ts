import { describe, expect, it } from "vitest";
import { clearSettlementCall, privateBalanceOn, setPrivateCall, SCHEDULES } from "./settle";

describe("settle settings", () => {
  it("the confidential balance is on only for the caller's own confidential destination", () => {
    const own = { chain: "confidential", address: "me.near", min_amount: "1000000" };
    expect(privateBalanceOn(own, "me.near")).toBe(true);
    expect(privateBalanceOn({ ...own, address: "other.near" }, "me.near")).toBe(false);
    expect(privateBalanceOn({ ...own, chain: "base" }, "me.near")).toBe(false);
    expect(privateBalanceOn(null, "me.near")).toBe(false);
  });

  it("turning it on sends the caller's own account, never another", () => {
    const call = setPrivateCall("openrail.near", "me.near");
    expect(call.methodName).toBe("set_settlement");
    expect(call.args).toEqual({ chain: "confidential", address: "me.near", min_amount: "1000000" });
    expect(call.deposit).toBe("0");
  });

  it("turning it off clears the destination", () => {
    expect(clearSettlementCall("openrail.near")).toMatchObject({
      methodName: "clear_settlement",
      args: {},
    });
  });

  it("offers the five schedules of the API", () => {
    expect(SCHEDULES.map((s) => s.id)).toEqual([
      "manual",
      "each_payment",
      "daily",
      "weekly",
      "monthly",
    ]);
  });
});
