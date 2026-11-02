/**
 * Issuer service core (blueprint 1.6 issuer row, 0.2 "who signs what").
 *
 * The API calls `prepareIssue` then `issueFor` for an invoice. The claim account is part of the
 * immutable terms hash, so the token id must be exact: `prepareIssue` reads the contract's
 * `next_token_id` from state and reserves it; `issueFor` verifies the chain still agrees before
 * signing `issue_for`, then waits for `c-<n>.<root>` to exist (blueprint 1.5.4).
 *
 * Two keys on `ISSUER_ACCOUNT_ID`: `ISSUER_PRIVATE_KEY` signs `issue_for`/`log_quote`;
 * `RELAY_PRIVATE_KEY` signs `acknowledge_evm` only.
 */
import type { Logger } from "@openrail/shared";
import { IssuerError } from "./errors.js";
import type {
  AccountChecker,
  AckEvmRequest,
  IssuerStateReader,
  IssueForRequest,
  LogQuoteRequest,
  NearClientLike,
  PrepareIssueResult,
} from "./types.js";

export const REQUIRED_ISSUE_DEPOSIT_YOCTO = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
const ISSUE_GAS = 250_000_000_000_000n;
const LOG_QUOTE_GAS = 50_000_000_000_000n;
const ACK_GAS = 50_000_000_000_000n;
const DEFAULT_RESERVATION_TTL_MS = 60_000;
const DEFAULT_ACCOUNT_WAIT_MS = 15_000;
const DEFAULT_ACCOUNT_POLL_MS = 250;

export interface IssuerServiceConfig {
  rootAccount: string;
  requiredDepositYocto: bigint;
  reservationTtlMs: number;
  accountWaitMs: number;
  accountPollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface IssuerServiceDeps {
  issuerNear: NearClientLike;
  relayNear: NearClientLike;
  state: IssuerStateReader;
  accounts: AccountChecker;
  config?: Partial<IssuerServiceConfig>;
  logger: Logger;
}

interface Reservation {
  business: string;
  tokenNumber: number;
  tokenId: string;
  claimAccount: string;
  expiresAt: number;
}

/** A tiny promise-chain mutex; keeps nonce use, reservations and state checks serial. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

function successValue(result: unknown): string | null {
  const status = (result as { status?: unknown } | null)?.status;
  if (status === null || status === undefined || typeof status !== "object") return null;
  if (!("SuccessValue" in status)) return null;
  const value = (status as { SuccessValue?: unknown }).SuccessValue;
  return typeof value === "string" ? value : "";
}

function assertSuccess(result: unknown): void {
  if (successValue(result) === null) throw new IssuerError(502, "NEAR_CALL_FAILED");
}

function txHashOf(result: unknown): string {
  const outcome = result as {
    transaction?: { hash?: unknown };
    transaction_outcome?: { id?: unknown };
  } | null;
  const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
  if (typeof hash !== "string" || hash === "") {
    throw new IssuerError(502, "NEAR_TX_HASH_MISSING");
  }
  return hash;
}

function returnStringOf(result: unknown): string {
  const value = successValue(result);
  if (value === null) throw new IssuerError(502, "NEAR_CALL_FAILED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new IssuerError(502, "NEAR_RETURN_INVALID");
  }
  if (typeof parsed !== "string") throw new IssuerError(502, "NEAR_RETURN_INVALID");
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IssuerService {
  private readonly issuerNear: NearClientLike;
  private readonly relayNear: NearClientLike;
  private readonly state: IssuerStateReader;
  private readonly accounts: AccountChecker;
  private readonly config: IssuerServiceConfig;
  private readonly logger: Logger;
  private readonly mutex = new Mutex();
  private reservation: Reservation | null = null;

  constructor(deps: IssuerServiceDeps) {
    this.issuerNear = deps.issuerNear;
    this.relayNear = deps.relayNear;
    this.state = deps.state;
    this.accounts = deps.accounts;
    this.logger = deps.logger;
    this.config = {
      rootAccount: deps.config?.rootAccount ?? "",
      requiredDepositYocto: deps.config?.requiredDepositYocto ?? REQUIRED_ISSUE_DEPOSIT_YOCTO,
      reservationTtlMs: deps.config?.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS,
      accountWaitMs: deps.config?.accountWaitMs ?? DEFAULT_ACCOUNT_WAIT_MS,
      accountPollMs: deps.config?.accountPollMs ?? DEFAULT_ACCOUNT_POLL_MS,
      now: deps.config?.now ?? Date.now,
      sleep: deps.config?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  /**
   * Returns the exact next token id / claim account for the terms hash, plus the account and
   * amount the business must deposit as storage credit.
   */
  async prepareIssue(business: string): Promise<PrepareIssueResult> {
    return this.mutex.run(async () => {
      const now = this.config.now();
      if (this.reservation !== null && this.reservation.expiresAt > now) {
        throw new IssuerError(409, "ISSUE_IN_FLIGHT");
      }
      this.reservation = null;

      const next = await this.state.nextTokenId();
      const credit = await this.state.storageCredit(business);
      const tokenId = `c-${next}`;
      const claimAccount = `${tokenId}.${this.config.rootAccount}`;
      this.reservation = {
        business,
        tokenNumber: next,
        tokenId,
        claimAccount,
        expiresAt: now + this.config.reservationTtlMs,
      };
      this.logger.info("prepared issue", tokenId, business);
      return {
        tokenId,
        claimAccount,
        account: this.config.rootAccount,
        amount: this.config.requiredDepositYocto.toString(),
        storageCredit: credit.toString(),
      };
    });
  }

  /** Signs `issue_for` with the issuer key and waits for the claim account to exist. */
  async issueFor(request: IssueForRequest): Promise<{ txHash: string; tokenId: string }> {
    return this.mutex.run(async () => {
      const now = this.config.now();
      const reservation = this.reservation;
      if (
        reservation === null ||
        reservation.business !== request.business ||
        reservation.expiresAt <= now
      ) {
        this.reservation = null;
        throw new IssuerError(409, "NO_PREPARED_ISSUE");
      }

      try {
        const onChain = await this.state.nextTokenId();
        if (onChain !== reservation.tokenNumber) {
          throw new IssuerError(409, "TOKEN_ID_RACE");
        }

        const result = await this.issuerNear.sendFunctionCall({
          receiverId: this.config.rootAccount,
          methodName: "issue_for",
          args: {
            business: request.business,
            kind: request.kind,
            debtor: request.debtor,
            terms_hash: request.termsHash,
            amount_due: request.amountDue,
            due_date: request.dueDate,
            metadata: request.metadata ?? null,
          },
          gas: ISSUE_GAS,
          deposit: 0n,
          feature: "issuer.issue_for",
        });
        assertSuccess(result);

        const returned = returnStringOf(result);
        if (returned !== reservation.tokenId) {
          throw new IssuerError(502, "ISSUE_ID_MISMATCH");
        }

        await this.waitForAccount(reservation.claimAccount);
        this.logger.info("issued", returned, request.business);
        return { txHash: txHashOf(result), tokenId: returned };
      } finally {
        this.reservation = null;
      }
    });
  }

  /** Appends the quote before the API returns a deposit address. */
  async logQuote(request: LogQuoteRequest): Promise<{ txHash: string }> {
    return this.mutex.run(async () => {
      const result = await this.issuerNear.sendFunctionCall({
        receiverId: this.config.rootAccount,
        methodName: "log_quote",
        args: {
          token_id: request.tokenId,
          quote: {
            quote_id: request.quoteId,
            deposit_address: request.depositAddress,
            deadline_requested: request.deadlineRequested,
            refund_to: request.refundTo,
            route_id: request.routeId,
          },
        },
        gas: LOG_QUOTE_GAS,
        deposit: 0n,
        feature: "issuer.log_quote",
      });
      assertSuccess(result);
      return { txHash: txHashOf(result) };
    });
  }

  /** Relays an EVM acknowledgement with the relay key (never the issuer key). */
  async acknowledgeEvm(request: AckEvmRequest): Promise<{ txHash: string; ack: unknown }> {
    return this.mutex.run(async () => {
      const result = await this.relayNear.sendFunctionCall({
        receiverId: this.config.rootAccount,
        methodName: "acknowledge_evm",
        args: {
          token_id: request.tokenId,
          chain_id: request.chainId,
          sig: request.signature,
        },
        gas: ACK_GAS,
        deposit: 0n,
        feature: "issuer.acknowledge_evm",
      });
      assertSuccess(result);

      let ack: unknown = null;
      try {
        const claim = await this.issuerNear.view<{ ack?: unknown } | null>({
          contractId: this.config.rootAccount,
          methodName: "claim",
          args: { token_id: request.tokenId },
          feature: "issuer.claim",
        });
        ack = claim?.ack ?? null;
      } catch (error) {
        this.logger.warn("ack written but claim view failed", errorMessage(error));
      }
      return { txHash: txHashOf(result), ack };
    });
  }

  private async waitForAccount(accountId: string): Promise<void> {
    const attempts = Math.max(
      1,
      Math.ceil(this.config.accountWaitMs / Math.max(1, this.config.accountPollMs)),
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.accounts.exists(accountId)) return;
      if (attempt + 1 < attempts) await this.config.sleep(this.config.accountPollMs);
    }
    throw new IssuerError(504, "CLAIM_ACCOUNT_NOT_READY");
  }
}
