import { describe, expect, it } from "vitest";
import { abortable } from "./abortable";
import { walletDetail } from "./wallet-detail";

describe("abortable", () => {
  it("passes the result through when nothing aborts", async () => {
    await expect(abortable(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });

  it("stops waiting for a wallet that never answers once the signal aborts", async () => {
    const ctl = new AbortController();
    const never = new Promise<number>(() => {});
    const waiting = abortable(never, ctl.signal);
    ctl.abort();
    await expect(waiting).rejects.toThrow("WALLET_CANCELLED");
  });

  it("rejects at once when the signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(abortable(new Promise<number>(() => {}), ctl.signal)).rejects.toThrow(
      "WALLET_CANCELLED",
    );
  });

  it("keeps the wallet's own error", async () => {
    await expect(
      abortable(Promise.reject(new Error("Insufficient balance")), new AbortController().signal),
    ).rejects.toThrow("Insufficient balance");
  });
});

describe("walletDetail", () => {
  it("returns one short line of the wallet's message", () => {
    expect(walletDetail(new Error("Insufficient   balance.\nAdd 0.1 NEAR"))).toBe(
      "Insufficient balance. Add 0.1 NEAR",
    );
  });
  it("hides our own internal codes and empty errors", () => {
    expect(walletDetail(new Error("WALLET_NO_SIGNATURE"))).toBeUndefined();
    expect(walletDetail(new Error("SIGNMESSAGE_UNSUPPORTED"))).toBeUndefined();
    expect(walletDetail(undefined)).toBeUndefined();
  });
  it("cuts a long message", () => {
    expect(walletDetail(new Error("x".repeat(300)))?.length).toBe(140);
  });
});
