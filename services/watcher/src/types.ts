/** Shapes read from the public core views (blueprint 2.1, 2.2, 2.5). */
import type { BatchBalanceRequest, FunctionCallRequest, ViewRequest } from "@openrail/shared";

export type ClaimStatus = "Issued" | "PartiallyPaid" | "Paid" | "Cancelled" | "Closed";

/** near-sdk serialises the lock enum externally tagged. */
export type ClaimLock =
  | "None"
  | { Reconciling: { since: number } }
  | { TransferWindow: { until: number } }
  | { Module: { id: string; until: number } };

export interface ClaimView {
  token_id: string;
  /** Claim kind; 0 is the standard invoice. Absent is read as an invoice (the safe side). */
  kind?: number;
  issuer_id: string;
  claim_account: string;
  status: ClaimStatus;
  lock: ClaimLock;
  settlement_assets: string[];
  /** Asset -> U128 as a decimal string. */
  last_seen_balance: Record<string, string>;
  undistributed: unknown[];
}

export interface Quote {
  quote_id: string;
  deposit_address: string;
  /** Unix seconds requested by the payer; 1Click's real deadline is +72 h. */
  deadline_requested: number;
  refund_to: string;
  route_id: string;
}

export interface ConfigView {
  settlement_assets: string[];
  issuers: string[];
  quote_writers: string[];
  issue_paused: boolean;
}

/** The subset of `@openrail/shared`'s `NearClient` the watcher needs. */
export interface NearClientLike {
  view<T>(request: ViewRequest): Promise<T>;
  batchBalanceOf(request: BatchBalanceRequest): Promise<string[]>;
  sendFunctionCall(request: FunctionCallRequest): Promise<unknown>;
  /** RPC requests made since the start, per feature (the shared client counts them). */
  callCounts?(): Record<string, number>;
  rpcHealth?(): {
    host: string;
    state: "ok" | "cooling";
    last_error: string | null;
    calls_last_hour: number;
  }[];
}

export interface ChainStatus {
  /** Latest final block height. */
  blockHeight(): Promise<number>;
  /** The watcher account's NEAR balance in yoctoNEAR. */
  accountBalanceYocto(accountId: string): Promise<bigint>;
  /** Status requests made since the start, per kind. */
  callCounts?(): Record<string, number>;
}
