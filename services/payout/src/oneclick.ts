/** 1Click quote/status adapters for the payout worker. */
import { createOneClickClientFromEnv, tokenIdFor, type Chain } from "@openrail/shared";
import type { Quote, QuotePort, StatusPort, StatusRecord } from "./types.js";

function hashList(value: unknown): { hash: string; explorerUrl?: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return { hash: entry };
      const record = entry as { hash?: unknown; explorerUrl?: unknown } | null;
      if (record === null || typeof record.hash !== "string") return null;
      return {
        hash: record.hash,
        ...(typeof record.explorerUrl === "string" ? { explorerUrl: record.explorerUrl } : {}),
      };
    })
    .filter((entry): entry is { hash: string; explorerUrl?: string } => entry !== null);
}

export class OneClickInPayout implements QuotePort, StatusPort {
  constructor(
    private readonly client: ReturnType<
      typeof createOneClickClientFromEnv
    > = createOneClickClientFromEnv(),
  ) {}

  async quote(request: Parameters<QuotePort["quote"]>[0]): Promise<Quote> {
    const shield = request.destination.chain === "confidential";
    const destinationAsset = shield
      ? request.asset
      : tokenIdFor(request.destination.chain as Chain, "USDC");
    const response = await this.client.quote({
      originAsset: request.asset,
      destinationAsset,
      amount: request.amount,
      swapType: "EXACT_INPUT",
      // 1Click rejects a quote without both (HTTP 400, 11 Nov). Not a dry run: the deposit address is needed.
      dry: false,
      // Same asset into the private balance moves no price; a swap to another chain gets 0.5 %.
      slippageTolerance: shield ? 0 : 50,
      depositType: "INTENTS",
      refundTo: request.refundTo,
      recipient: request.destination.address,
      recipientType: shield ? "CONFIDENTIAL_INTENTS" : "DESTINATION_CHAIN",
      ...(shield ? { refundType: "INTENTS" } : {}),
      deadline: request.deadline,
    });
    const quote = response.quote;
    return {
      amountIn: quote.amountIn ?? request.amount,
      depositAddress: quote.depositAddress ?? "",
      recipient: String(quote.recipient ?? response.quoteRequest?.recipient ?? ""),
      destinationAsset,
      deadline: quote.deadline ?? request.deadline,
    };
  }

  async status(depositAddress: string): Promise<StatusRecord> {
    const response = await this.client.status(depositAddress);
    const details = response.swapDetails;
    return {
      status: response.status ?? "PENDING_DEPOSIT",
      destinationTxHashes: hashList(details.destinationChainTxHashes),
      ...(typeof details.amountOut === "string" && response.status === "REFUNDED"
        ? { refundedAmount: details.amountOut }
        : {}),
    };
  }
}
