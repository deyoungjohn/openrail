/** NEAR adapter for the settle/payout views and calls. */
import { getEnv, nearClientFromEnv, type NearClient } from "@openrail/shared";
import type { DatabaseSync } from "node:sqlite";
import { appendOutcomeEvents, type OutcomeLike } from "@openrail/shared";
import type { CallBudget } from "./budget.js";
import type {
  ChainPort,
  CheckoutRefundEvent,
  Destination,
  HeldEntry,
  PayoutOutcome,
  PayoutRecord,
} from "./types.js";

function successValue(result: unknown): unknown {
  const status = (result as { status?: Record<string, unknown> } | null)?.status;
  const value = status?.SuccessValue;
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function txHash(result: unknown): string {
  const outcome = result as {
    transaction?: { hash?: unknown };
    transaction_outcome?: { id?: unknown };
  } | null;
  const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
  return typeof hash === "string" ? hash : "";
}

export interface PayoutChainOptions {
  rootAccount: string;
  near?: NearClient;
  budget?: CallBudget;
  /** Indexer `/events` endpoint, used to read the checkout refund event payload. */
  indexerUrl?: string;
  /**
   * This worker's own single-writer event file (`events` table, see `ensureEventTable`): every `EVENT_JSON` log of the
   * transactions it sends is written here, and the indexer reads it, so the dashboard learns `settle_sent`,
   * `settle_settled` and `settle_refunded` without a NearBlocks or RPC lookup.
   */
  eventDb?: DatabaseSync;
  now?: () => number;
}

function u128(value: unknown): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (value !== null && typeof value === "object" && "0" in value) {
    const inner = (value as { 0?: unknown })["0"];
    if (typeof inner === "string" && /^\d+$/.test(inner)) return inner;
    if (typeof inner === "number" && Number.isSafeInteger(inner) && inner >= 0)
      return String(inner);
  }
  return "0";
}

/**
 * The contract's `PayoutOutcome` is internally tagged (`#[serde(tag = "outcome", rename_all = "snake_case")]`): it
 * reads `{"outcome":"settled","destination_tx":"..."}`, not `{"Settled":{...}}`. The old shape failed every report on
 * 13 Nov and the retries spent about 0.3 NEAR of the relayer's balance.
 */
export function outcomeJson(outcome: PayoutOutcome): Record<string, unknown> {
  if ("Settled" in outcome)
    return { outcome: "settled", destination_tx: outcome.Settled.destination_tx };
  return { outcome: "refunded", amount: outcome.Refunded.amount };
}

export class PayoutChain implements ChainPort {
  private readonly near: NearClient;
  private readonly rootAccount: string;
  private readonly budget: CallBudget | undefined;
  private readonly indexerUrl: string | undefined;
  private readonly eventDb: DatabaseSync | undefined;
  private readonly now: () => number;
  /** Events that could not be written (counted in health). */
  eventWriteFailures = 0;

  constructor(options: PayoutChainOptions) {
    this.eventDb = options.eventDb;
    this.now = options.now ?? Date.now;
    this.rootAccount = options.rootAccount;
    this.budget = options.budget;
    this.indexerUrl =
      options.indexerUrl === undefined ? undefined : options.indexerUrl.replace(/\/+$/, "");
    this.near =
      options.near ??
      nearClientFromEnv({
        signer: {
          accountIdEnv: "PAYOUT_RELAYER_ACCOUNT_ID",
          privateKeyEnv: "PAYOUT_RELAYER_PRIVATE_KEY",
        },
      });
  }

  /** Best effort: a failing write never stops a payout, it is counted. */
  private record(result: unknown, tokenId: string): void {
    if (this.eventDb === undefined) return;
    try {
      appendOutcomeEvents(this.eventDb, (result ?? {}) as OutcomeLike, {
        tokenId,
        blockHeight: 0,
        timestamp: Math.floor(this.now() / 1000),
        source: "payout",
      });
    } catch {
      this.eventWriteFailures += 1;
    }
  }

  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    await this.budget?.beforeCall();
    try {
      return await call();
    } finally {
      this.budget?.recordCall();
    }
  }

  async settleHeld(tokenId: string): Promise<HeldEntry[]> {
    return this.guarded(() =>
      this.near.view<HeldEntry[]>({
        contractId: this.rootAccount,
        methodName: "settle_held",
        args: { token_id: tokenId },
        feature: "payout.settle_held",
      }),
    );
  }

  async settlementOf(owner: string): Promise<Destination | null> {
    return this.guarded(() =>
      this.near.view<Destination | null>({
        contractId: this.rootAccount,
        methodName: "settlement_of",
        args: { account_id: owner },
        feature: "payout.settlement_of",
      }),
    );
  }

  async claimAccount(tokenId: string): Promise<string> {
    const claim = await this.guarded(() =>
      this.near.view<{ claim_account?: unknown } | null>({
        contractId: this.rootAccount,
        methodName: "claim",
        args: { token_id: tokenId },
        feature: "payout.claim",
      }),
    );
    if (claim === null || typeof claim.claim_account !== "string") {
      throw new Error(`PAYOUT_CLAIM_NOT_FOUND: ${tokenId}`);
    }
    return claim.claim_account;
  }

  async payout(payoutId: number): Promise<PayoutRecord | null> {
    return this.guarded(() =>
      this.near.view<PayoutRecord | null>({
        contractId: this.rootAccount,
        methodName: "payout",
        args: { payout_id: payoutId },
        feature: "payout.payout",
      }),
    );
  }

  async settlePayout(
    tokenId: string,
    index: number,
    depositAddress: string,
    amountIn: string,
  ): Promise<{ payoutId: number; txHash: string }> {
    const result = await this.guarded(() =>
      this.near.sendFunctionCall({
        receiverId: this.rootAccount,
        methodName: "settle_payout",
        args: {
          token_id: tokenId,
          index,
          deposit_address: depositAddress,
          amount_in: amountIn,
        },
        gas: 300_000_000_000_000n,
        deposit: 0n,
        feature: "payout.settle_payout",
      }),
    );
    this.record(result, tokenId);
    const value = successValue(result);
    const payoutId = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(payoutId) || payoutId <= 0) {
      throw new Error("PAYOUT_ID_MISSING");
    }
    return { payoutId, txHash: txHash(result) };
  }

  async refundLate(
    tokenId: string,
    depositAddress: string,
    amountIn: string,
  ): Promise<{ payoutId: number; txHash: string }> {
    const result = await this.guarded(() =>
      this.near.sendFunctionCall({
        receiverId: this.rootAccount,
        methodName: "refund_late",
        args: {
          token_id: tokenId,
          deposit_address: depositAddress,
          amount_in: amountIn,
        },
        gas: 300_000_000_000_000n,
        deposit: 0n,
        feature: "payout.refund_late",
      }),
    );
    this.record(result, tokenId);
    const value = successValue(result);
    const payoutId = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(payoutId) || payoutId <= 0) {
      throw new Error("PAYOUT_ID_MISSING");
    }
    return { payoutId, txHash: txHash(result) };
  }

  async bookedNet(tokenId: string): Promise<string> {
    const claim = await this.guarded(() =>
      this.near.view<{ booked_total?: unknown; fee_total?: unknown } | null>({
        contractId: this.rootAccount,
        methodName: "claim",
        args: { token_id: tokenId },
        feature: "payout.claim",
      }),
    );
    if (claim === null) return "0";
    const booked = BigInt(u128(claim.booked_total));
    const fee = BigInt(u128(claim.fee_total));
    return (booked > fee ? booked - fee : 0n).toString();
  }

  async checkoutRefundEvents(tokenId: string): Promise<CheckoutRefundEvent[]> {
    if (this.indexerUrl === undefined) return [];
    const response = await fetch(
      `${this.indexerUrl}/events?token_id=${encodeURIComponent(tokenId)}&limit=200`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(`INDEXER_HTTP_${response.status}`);
    const body = (await response.json()) as {
      data?: { event?: unknown; data?: Record<string, unknown> }[];
    };
    const rows = (body.data ?? []).filter((row) => row.event === "checkout_refund_started");
    if (rows.length === 0) return [];
    const claim = await this.guarded(() =>
      this.near.view<{ settlement_assets?: unknown } | null>({
        contractId: this.rootAccount,
        methodName: "claim",
        args: { token_id: tokenId },
        feature: "payout.claim",
      }),
    );
    const assets = claim?.settlement_assets;
    const asset =
      Array.isArray(assets) && typeof assets[0] === "string"
        ? assets[0]
        : typeof assets === "string"
          ? assets
          : "";
    const events: CheckoutRefundEvent[] = [];
    for (const row of rows) {
      const data = row.data ?? {};
      const refundTo = typeof data.refund_to === "string" ? data.refund_to : "";
      const amount = u128(data.amount_in ?? data.amount);
      const payoutId = Number(data.payout_id);
      if (refundTo === "" || amount === "0") continue;
      events.push({
        tokenId,
        refundTo,
        amount,
        asset: typeof data.asset === "string" ? data.asset : asset,
        ...(Number.isSafeInteger(payoutId) && payoutId > 0
          ? { status: { InFlight: { payout_id: payoutId } } }
          : {}),
      });
    }
    return events;
  }

  async reportPayout(
    tokenId: string,
    index: number,
    payoutId: number,
    outcome: PayoutOutcome,
  ): Promise<void> {
    const result = await this.guarded(() =>
      this.near.sendFunctionCall({
        receiverId: this.rootAccount,
        methodName: "report_payout",
        args: { token_id: tokenId, index, payout_id: payoutId, outcome: outcomeJson(outcome) },
        gas: 100_000_000_000_000n,
        deposit: 0n,
        feature: "payout.report_payout",
      }),
    );
    this.record(result, tokenId);
  }

  /** The relayer's NEAR balance, read through the shared RPC cycle. A failed read throws: it is not a zero balance. */
  async balanceYocto(): Promise<bigint> {
    const account = getEnv("PAYOUT_RELAYER_ACCOUNT_ID") ?? "";
    if (account === "") throw new Error("MISSING_ENV: PAYOUT_RELAYER_ACCOUNT_ID");
    // Not counted in the settle call budget: it is read every ten minutes, and counting it would spend the day's calls
    // (11 Nov: the budget ran out and the held entry could not be paid).
    return this.near.accountBalanceYocto(account);
  }
}
