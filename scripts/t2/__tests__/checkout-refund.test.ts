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
});
