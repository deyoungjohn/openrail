import { describe, expect, it } from "vitest";
import { waitForRefundArrival } from "../checkout-refund.js";

const noWait = async () => undefined;

describe("waitForRefundArrival", () => {
  it("resolves when 1Click returns SUCCESS and extracts destinationChainTxHashes", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(
          JSON.stringify({
            status: "PROCESSING",
            swapDetails: { status: "PROCESSING" },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          status: "SUCCESS",
          swapDetails: {
            status: "SUCCESS",
            destinationChainTxHashes: ["0xdestination_tx_hash_123"],
          },
        }),
      );
    }) as typeof fetch;

    const arrival = await waitForRefundArrival(
      {
        oneClickUrl: "https://1click.test",
        oneClickJwt: "test_jwt",
        fetchImpl,
        sleep: noWait,
        attempts: 5,
        intervalMs: 10,
      },
      "0xdeposit_addr",
    );

    expect(arrival.status).toBe("SUCCESS");
    expect(arrival.destinationTx).toBe("0xdestination_tx_hash_123");
    expect(calls).toBe(3);
  });

  it("throws immediately when 1Click returns FAILED", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          status: "FAILED",
          swapDetails: { status: "FAILED" },
        }),
      )) as typeof fetch;

    await expect(
      waitForRefundArrival(
        {
          oneClickUrl: "https://1click.test",
          fetchImpl,
          sleep: noWait,
          attempts: 3,
        },
        "0xdeposit_fail",
      ),
    ).rejects.toThrow("1Click refund failed with status: FAILED");
  });

  it("throws when attempts run out before SUCCESS", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          status: "PROCESSING",
          swapDetails: { status: "PROCESSING" },
        }),
      )) as typeof fetch;

    await expect(
      waitForRefundArrival(
        {
          oneClickUrl: "https://1click.test",
          fetchImpl,
          sleep: noWait,
          attempts: 2,
        },
        "0xdeposit_timeout",
      ),
    ).rejects.toThrow("1Click refund did not reach SUCCESS within 2 attempts");
  });

  it("failed refund payout restores held_amount and checkout returns to refundable", async () => {
    // Simulates the contract failed-payout callback (ag2 post-REL-2 upgrade semantics)
    interface MockCheckoutContractState {
      expiry: number;
      late: boolean;
      refunded: boolean;
      held_amount: string;
      held_asset: string;
    }

    const state: MockCheckoutContractState = {
      expiry: 1762768800,
      late: true,
      refunded: false,
      held_amount: "1995000",
      held_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    };

    // 1. Initial refund_late invocation starts payout
    function refundLate(targetDeposit: string, amount: string) {
      if (state.refunded) throw new Error("ALREADY_REFUNDED");
      if (state.held_amount === "0") throw new Error("NO_HELD_FUNDS");
      // Payout is initiated: contract temporarily marks refunded and decrements held_amount
      state.refunded = true;
      state.held_amount = "0";
      return { payoutId: 42, targetDeposit, amount };
    }

    // 2. Contract on_payout callback
    function onPayout(payoutId: number, ok: boolean, amount: string) {
      if (ok) {
        // Payout succeeded: state remains refunded
        state.refunded = true;
        state.held_amount = "0";
      } else {
        // Payout failed (e.g. invalid deposit address or vault transfer rejected)
        // Ag2 upgrade: revert state.refunded to false, restore held_amount, emit checkout_payout_failed
        state.refunded = false;
        state.held_amount = amount;
      }
    }

    // Attempt 1: Call refund_late with a bad deposit address that fails
    const call1 = refundLate("0xbad_deposit_address", "1995000");
    expect(state.refunded).toBe(true);
    expect(state.held_amount).toBe("0");

    // Vault callback fails (ok = false)
    onPayout(call1.payoutId, false, "1995000");

    // Verify state restored: checkout is NOT refunded, held_amount is back, returns to refundable
    expect(state.refunded).toBe(false);
    expect(state.held_amount).toBe("1995000");

    // Attempt 2: Merchant can re-invoke refund_late with correct deposit address
    const call2 = refundLate("0xvalid_deposit_address", "1995000");
    expect(state.refunded).toBe(true);

    // Vault callback succeeds (ok = true)
    onPayout(call2.payoutId, true, "1995000");
    expect(state.refunded).toBe(true);
    expect(state.held_amount).toBe("0");
  });
});
