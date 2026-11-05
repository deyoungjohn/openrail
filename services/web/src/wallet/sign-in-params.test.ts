import { describe, expect, it } from "vitest";
import { signInParams } from "./sign-in-params";

describe("signInParams", () => {
  it("connects most wallets without a contract, so no access key is added", () => {
    for (const id of ["meteor-wallet", "nightly", "hot-wallet", "wallet-connect"]) {
      expect(signInParams(id, "openrail.near")).toEqual({});
    }
  });
  it("gives Here Wallet the contract it needs to store the account before signing", () => {
    expect(signInParams("here-wallet", "openrail.near")).toEqual({ contractId: "openrail.near" });
  });
});
