/** Port shapes from `services/api/src/app.ts` (`IssuerPort`). */
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
  /** The id `prepareIssue` predicted; a different minted id is refused as TOKEN_ID_MISMATCH. */
  expectedTokenId?: string;
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
  /** The business deposits NEAR storage credit to this account. */
  account: string;
  /** Required deposit in yoctoNEAR (0.02 NEAR today). */
  amount: string;
  /** Current `storage_credit_of(business)` in yoctoNEAR. */
  storageCredit: string;
  /**
   * The id the next `issue_for` will mint, predicted from the contract's newest token and the highest id this
   * service has seen. The terms hash binds the claim account, so the API needs it before the mint. It is
   * checked after the mint (`expectedTokenId`).
   */
  tokenId?: string;
  claimAccount?: string;
}

/** The number n of the newest claim `c-n` on the contract, or 0 when there is none. */
export interface TokenCounter {
  lastTokenNumber(): Promise<number>;
}

export interface PrepareIssueBody {
  account_id: string;
}

/** Reads the business's storage credit through the `storage_credit_of` view. */
export interface StorageCreditReader {
  storageCreditOf(business: string): Promise<bigint>;
}

/** Polls whether a claim account exists (blueprint 1.5.4). */
export interface AccountChecker {
  exists(accountId: string): Promise<boolean>;
}

export interface KeyInfo {
  kind: "FullAccess" | "FunctionCall";
  methods: string[];
  allowance: string | null;
}

/** Reads a key's permission/allowance for the startup self-check and `/health`. */
export interface KeyInspector {
  keyInfo(accountId: string, publicKey: string): Promise<KeyInfo>;
}
