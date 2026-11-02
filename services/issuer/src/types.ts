/** Port shapes from `services/api/src/app.ts` (`IssuerPort`, PR #27). */
import type { FunctionCallRequest, ViewRequest } from "@openrail/shared";

export interface NearClientLike {
  view<T>(request: ViewRequest): Promise<T>;
  sendFunctionCall(request: FunctionCallRequest): Promise<unknown>;
}

export type Debtor = { Near: string } | { Evm: string };

export interface IssueForRequest {
  business: string;
  kind: number;
  debtor: Debtor | null;
  termsHash: string;
  amountDue: string;
  dueDate: number;
  metadata?: Record<string, unknown>;
}

export interface LogQuoteRequest {
  tokenId: string;
  quoteId: string;
  depositAddress: string;
  deadlineRequested: number;
  refundTo: string;
  routeId: string;
}

export interface AckEvmRequest {
  tokenId: string;
  chainId: number;
  signature: string;
}

export interface PrepareIssueResult {
  /** `{ tokenId, claimAccount }` is what the API consumes. */
  tokenId: string;
  claimAccount: string;
  /** The business deposits this NEAR storage credit to this account. */
  account: string;
  amount: string;
  /** Current `storage_credit[business]` in yoctoNEAR. */
  storageCredit: string;
}

export interface PrepareIssueBody {
  account_id: string;
}

/** Reads the two values the public ABI does not expose. */
export interface IssuerStateReader {
  /** Contract `next_token_id` (the state's last Borsh field). */
  nextTokenId(): Promise<number>;
  /** `storage_credit[business]` in yoctoNEAR. */
  storageCredit(business: string): Promise<bigint>;
}

/** Polls whether a claim account exists (blueprint 1.5.4). */
export interface AccountChecker {
  exists(accountId: string): Promise<boolean>;
}
