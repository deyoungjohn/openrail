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
  /** REL-2: `<username>-<ref>` label for the claim account; sent only when CLAIM_LABELS is on. */
  claimLabel?: string;
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
  /** The pool can cover the next invoice when the business has no own credit. */
  sponsored?: boolean;
  sponsorPool?: string;
  sponsorCap?: number;
  sponsorUsed?: number;
  sponsoredRemaining?: number;
}

/** The next claim number n; `c-n` is safe to predict after the newest claim. */
export interface TokenCounter {
  nextTokenId(): Promise<number>;
}

export interface PrepareIssueBody {
  account_id: string;
}

export interface SponsorStatus {
  pool: bigint;
  cap: number;
  used: number;
}

/** Reads `sponsor_status(account_id)`. */
export interface SponsorStatusReader {
  sponsorStatusOf(business: string): Promise<SponsorStatus>;
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
