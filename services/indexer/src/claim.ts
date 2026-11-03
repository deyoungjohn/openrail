import type { NearClient } from "@openrail/shared";
import type { ClaimReader, ClaimViewTotals } from "./types.js";

interface ClaimView {
  token_id: string;
  amount_due: string;
  booked_total: string;
  distributed_total: string;
  fee_total: string;
  surplus: string;
  credit_total: string;
  status: string;
  terms_hash: string;
  due_date: number;
}

export class ContractClaimReader implements ClaimReader {
  constructor(
    private readonly near: NearClient,
    private readonly rootAccount: string,
  ) {}

  async claim(tokenId: string): Promise<ClaimViewTotals | null> {
    const view = await this.near.view<ClaimView | null>({
      contractId: this.rootAccount,
      methodName: "claim",
      args: { token_id: tokenId },
      feature: "indexer.claim",
    });
    if (view === null) return null;
    return {
      token_id: view.token_id,
      amount_due: view.amount_due,
      booked_total: view.booked_total,
      distributed_total: view.distributed_total,
      fee_total: view.fee_total,
      surplus: view.surplus,
      credit_total: view.credit_total,
      status: view.status,
      terms_hash: view.terms_hash,
      due_date: view.due_date,
    };
  }
}
