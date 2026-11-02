/**
 * Receipt enrichment: a receipt exists only because a `booked` event exists
 * (`receipt_equals_booked_event`). The origin/NEAR hashes come from 1Click `/v0/status` for the
 * latest quote of the claim; the verifier is a port so tests can fake the chain check.
 */
import type { ReceiptEnricher, ReceiptEvidence } from "./types.js";

export interface OneClickStatus {
  status?: string;
  swapDetails: {
    status?: string;
    amountOut?: string;
    depositedAmount?: string;
    originChainTxHashes?: string[];
    nearTxHashes?: string[];
    [key: string]: unknown;
  };
}

export interface StatusClient {
  status(depositAddress: string): Promise<OneClickStatus>;
}

export interface OriginCheckInput {
  routeId: string;
  originTxHash: string;
  depositAddress: string;
  expectedAmount: string;
  statusAmount: string;
}

export interface OriginVerifier {
  verify(input: OriginCheckInput): Promise<{ ok: boolean; sender: string }>;
}

/** Default check: 1Click reported SUCCESS and the destination amount covers the booking. */
export class StatusAmountVerifier implements OriginVerifier {
  async verify(input: OriginCheckInput): Promise<{ ok: boolean; sender: string }> {
    try {
      return {
        ok: BigInt(input.statusAmount) >= BigInt(input.expectedAmount),
        sender: "",
      };
    } catch {
      return { ok: false, sender: "" };
    }
  }
}

const EVM_ROUTES = new Set(["base", "arbitrum", "optimism", "polygon", "ethereum", "eth", "bnb"]);

interface EvmTransaction {
  from?: string;
  to?: string;
  input?: string;
}

/** Checks the origin transaction on an EVM RPC and that it pays the 1Click deposit address. */
export class EvmOriginVerifier implements OriginVerifier {
  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (
      input,
      init,
    ) => fetch(input, init),
    private readonly fallback: OriginVerifier = new StatusAmountVerifier(),
  ) {}

  async verify(input: OriginCheckInput): Promise<{ ok: boolean; sender: string }> {
    const route = input.routeId.split("-")[0] ?? input.routeId;
    if (!EVM_ROUTES.has(route)) return this.fallback.verify(input);

    let transaction: EvmTransaction | null = null;
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionByHash",
          params: [input.originTxHash],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const body = (await response.json()) as { result?: EvmTransaction | null };
        transaction = body.result ?? null;
      }
    } catch {
      transaction = null;
    }
    if (transaction === null || transaction === undefined) {
      return { ok: false, sender: "" };
    }
    const sender = typeof transaction.from === "string" ? transaction.from : "";
    const deposit = input.depositAddress.toLowerCase();
    const to = typeof transaction.to === "string" ? transaction.to.toLowerCase() : "";
    const data = typeof transaction.input === "string" ? transaction.input.toLowerCase() : "";
    let paysDeposit = to === deposit;
    if (!paysDeposit && data.startsWith("0xa9059cbb") && data.length >= 74) {
      paysDeposit = `0x${data.slice(34, 74)}` === deposit;
    }
    const amount = await this.fallback.verify(input);
    return { ok: paysDeposit && amount.ok, sender };
  }
}

export class OneClickReceiptEnricher implements ReceiptEnricher {
  constructor(
    private readonly quoteFor: (
      tokenId: string,
    ) => { depositAddress: string; routeId: string } | null,
    private readonly client: StatusClient,
    private readonly verifier: OriginVerifier = new StatusAmountVerifier(),
  ) {}

  async enrich(booking: {
    tokenId: string;
    txHash: string;
    payment: string;
    asset: string;
    blockTimestamp: number;
  }): Promise<ReceiptEvidence> {
    const quote = this.quoteFor(booking.tokenId);
    if (quote === null) {
      return { origin_tx: null, near_tx_hashes: [], verified: false };
    }
    let status: OneClickStatus;
    try {
      status = await this.client.status(quote.depositAddress);
    } catch {
      return { origin_tx: null, near_tx_hashes: [], verified: false };
    }
    const swap = status.swapDetails ?? {};
    const originHash = swap.originChainTxHashes?.[0];
    const nearHashes = Array.isArray(swap.nearTxHashes) ? swap.nearTxHashes : [];
    if (originHash === undefined) {
      return { origin_tx: null, near_tx_hashes: nearHashes, verified: false };
    }
    const statusAmount = swap.amountOut ?? swap.depositedAmount ?? "0";
    const check = await this.verifier.verify({
      routeId: quote.routeId,
      originTxHash: originHash,
      depositAddress: quote.depositAddress,
      expectedAmount: booking.payment,
      statusAmount,
    });
    return {
      origin_tx: {
        chain: quote.routeId,
        hash: originHash,
        sender: check.sender,
        amount: statusAmount,
      },
      near_tx_hashes: nearHashes,
      verified: check.ok && (swap.status === "SUCCESS" || status.status === "SUCCESS"),
    };
  }
}
