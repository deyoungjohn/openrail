/** NEAR adapter for the settle/payout views and calls. */
import { getEnv, nearClientFromEnv, requireEnv, type NearClient } from "@openrail/shared";
import type { CallBudget } from "./budget.js";
import type { ChainPort, Destination, HeldEntry, PayoutOutcome, PayoutRecord } from "./types.js";

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
}

export class PayoutChain implements ChainPort {
  private readonly near: NearClient;
  private readonly rootAccount: string;
  private readonly budget: CallBudget | undefined;

  constructor(options: PayoutChainOptions) {
    this.rootAccount = options.rootAccount;
    this.budget = options.budget;
    this.near =
      options.near ??
      nearClientFromEnv({
        signer: {
          accountIdEnv: "PAYOUT_RELAYER_ACCOUNT_ID",
          privateKeyEnv: "PAYOUT_RELAYER_PRIVATE_KEY",
        },
      });
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
    const value = successValue(result);
    const payoutId = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(payoutId) || payoutId <= 0) {
      throw new Error("PAYOUT_ID_MISSING");
    }
    return { payoutId, txHash: txHash(result) };
  }

  async reportPayout(
    tokenId: string,
    index: number,
    payoutId: number,
    outcome: PayoutOutcome,
  ): Promise<void> {
    await this.guarded(() =>
      this.near.sendFunctionCall({
        receiverId: this.rootAccount,
        methodName: "report_payout",
        args: { token_id: tokenId, index, payout_id: payoutId, outcome },
        gas: 100_000_000_000_000n,
        deposit: 0n,
        feature: "payout.report_payout",
      }),
    );
  }

  async balanceYocto(): Promise<bigint> {
    const rpc = requireEnv("NEAR_RPC_URL").split(",")[0];
    const account = getEnv("PAYOUT_RELAYER_ACCOUNT_ID") ?? "";
    if (rpc === undefined || account === "") return 0n;
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: account },
      }),
    });
    const body = (await response.json()) as { result?: { amount?: unknown } };
    return typeof body.result?.amount === "string" ? BigInt(body.result.amount) : 0n;
  }
}
