import { describe, expect, it } from "vitest";
import {
  EvmOriginVerifier,
  OneClickReceiptEnricher,
  StatusAmountVerifier,
  type OneClickStatus,
  type OriginCheckInput,
  type OriginVerifier,
  type StatusClient,
} from "./receipt.js";

const BOOKING = {
  tokenId: "c-1",
  txHash: "TxPay1",
  payment: "12500000",
  asset: "nep141:usdc",
  blockTimestamp: 1793613660,
};

const STATUS: OneClickStatus = {
  status: "SUCCESS",
  swapDetails: {
    status: "SUCCESS",
    amountOut: "12500000",
    originChainTxHashes: ["0x" + "cc".repeat(32)],
    nearTxHashes: ["NearHash1", "NearHash2"],
  },
};

class FakeStatus implements StatusClient {
  constructor(private readonly value: OneClickStatus | Error) {}
  async status(): Promise<OneClickStatus> {
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

const quote = (): { depositAddress: string; routeId: string } => ({
  depositAddress: "0xdeposit",
  routeId: "base-usdc",
});

describe("receipt enrichment", () => {
  it("adds the origin tx and NEAR hashes from 1Click status", async () => {
    const enricher = new OneClickReceiptEnricher(
      quote,
      new FakeStatus(STATUS),
      new StatusAmountVerifier(),
    );
    await expect(enricher.enrich(BOOKING)).resolves.toEqual({
      origin_tx: {
        chain: "base-usdc",
        hash: "0x" + "cc".repeat(32),
        sender: "",
        amount: "12500000",
      },
      near_tx_hashes: ["NearHash1", "NearHash2"],
      verified: true,
    });
  });

  it("marks the receipt unverified when the status amount is short", async () => {
    const short: OneClickStatus = {
      status: "SUCCESS",
      swapDetails: { ...STATUS.swapDetails, amountOut: "1" },
    };
    const enricher = new OneClickReceiptEnricher(
      quote,
      new FakeStatus(short),
      new StatusAmountVerifier(),
    );
    const evidence = await enricher.enrich(BOOKING);
    expect(evidence.verified).toBe(false);
    expect(evidence.origin_tx?.hash).toBe("0x" + "cc".repeat(32));
  });

  it("returns no origin when the token has no quote", async () => {
    const enricher = new OneClickReceiptEnricher(
      () => null,
      new FakeStatus(STATUS),
      new StatusAmountVerifier(),
    );
    await expect(enricher.enrich(BOOKING)).resolves.toEqual({
      origin_tx: null,
      near_tx_hashes: [],
      verified: false,
    });
  });

  it("returns no origin when the status provider fails", async () => {
    const enricher = new OneClickReceiptEnricher(
      quote,
      new FakeStatus(new Error("provider down")),
      new StatusAmountVerifier(),
    );
    const evidence = await enricher.enrich(BOOKING);
    expect(evidence.origin_tx).toBeNull();
    expect(evidence.verified).toBe(false);
  });

  it("honours an injected chain verifier", async () => {
    const verifier: OriginVerifier = {
      async verify() {
        return { ok: false, sender: "0x" + "ee".repeat(20) };
      },
    };
    const enricher = new OneClickReceiptEnricher(quote, new FakeStatus(STATUS), verifier);
    const evidence = await enricher.enrich(BOOKING);
    expect(evidence.origin_tx?.sender).toBe("0x" + "ee".repeat(20));
    expect(evidence.verified).toBe(false);
  });
});

const DEPOSIT = "0x" + "ab".repeat(20);

function evmFetch(result: unknown): (input: string, init?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

const CHECK: OriginCheckInput = {
  routeId: "base-usdc",
  originTxHash: "0x" + "cc".repeat(32),
  depositAddress: DEPOSIT,
  expectedAmount: "12500000",
  statusAmount: "12500000",
};

describe("EVM origin verifier", () => {
  it("accepts a native transfer to the deposit address", async () => {
    const verifier = new EvmOriginVerifier(
      "https://evm.test",
      evmFetch({ from: "0x" + "ee".repeat(20), to: DEPOSIT, input: "0x" }),
    );
    await expect(verifier.verify(CHECK)).resolves.toEqual({
      ok: true,
      sender: "0x" + "ee".repeat(20),
    });
  });

  it("accepts an ERC-20 transfer whose recipient is the deposit address", async () => {
    const input = `0xa9059cbb${"0".repeat(24)}${DEPOSIT.slice(2)}`;
    const verifier = new EvmOriginVerifier(
      "https://evm.test",
      evmFetch({ from: "0x" + "ee".repeat(20), to: "0x" + "11".repeat(20), input }),
    );
    await expect(verifier.verify(CHECK)).resolves.toMatchObject({ ok: true });
  });

  it("rejects a transaction that pays another address", async () => {
    const verifier = new EvmOriginVerifier(
      "https://evm.test",
      evmFetch({ from: "0x" + "ee".repeat(20), to: "0x" + "11".repeat(20), input: "0x" }),
    );
    await expect(verifier.verify(CHECK)).resolves.toMatchObject({ ok: false });
  });

  it("rejects a missing transaction", async () => {
    const verifier = new EvmOriginVerifier("https://evm.test", evmFetch(null));
    await expect(verifier.verify(CHECK)).resolves.toMatchObject({ ok: false });
  });

  it("falls back to the status amount check for non-EVM routes", async () => {
    const verifier = new EvmOriginVerifier("https://evm.test", evmFetch(null));
    await expect(verifier.verify({ ...CHECK, routeId: "sol-usdc" })).resolves.toMatchObject({
      ok: true,
    });
  });
});
