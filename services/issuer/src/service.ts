/**
 * Issuer service core (blueprint 1.6 issuer row, 0.2 "who signs what").
 *
 * The claim account is part of the immutable terms hash, so the API must not guess it.
 * `issueFor` reads the token id from the `issue_for` receipt result, derives `c-<n>.<root>`
 * and waits for that account to exist (blueprint 1.5.4). `prepareIssue` only reports the
 * storage credit and the NEAR account/amount the business should top up.
 *
 * Two keys on `ISSUER_ACCOUNT_ID`: `ISSUER_PRIVATE_KEY` signs `issue_for`/`log_quote`;
 * `RELAY_PRIVATE_KEY` signs `acknowledge_evm` only.
 */
import type { IndexerControl, Logger } from "@openrail/shared";
import { IssuerError } from "./errors.js";
import type {
  AccountChecker,
  AckEvmRequest,
  IssueForRequest,
  LogQuoteRequest,
  NearClientLike,
  PrepareIssueResult,
  SponsorStatus,
  SponsorStatusReader,
  StorageCreditReader,
  TokenCounter,
} from "./types.js";

export const REQUIRED_ISSUE_DEPOSIT_YOCTO = 20_000_000_000_000_000_000_000n; // 0.02 NEAR

/**
 * Measured on the C1 sandbox (2026-11-02): `issue_for` burned 14.0 Tgas in total (0.32 Tgas
 * in the call itself; the rest in the account creation and the 30 Tgas callback). 60 Tgas is
 * a 4x headroom and keeps a 2 NEAR key allowance good for ~330 issues.
 */
const ISSUE_GAS = 60_000_000_000_000n;
/** Measured on the C1 sandbox: `log_quote` burned 2.5 Tgas in total. */
const LOG_QUOTE_GAS = 10_000_000_000_000n;
/** K14 mainnet: `acknowledge_evm` burned 2.57 Tgas (ecrecover + storage). */
const ACK_GAS = 10_000_000_000_000n;
const DEFAULT_ACCOUNT_WAIT_MS = 15_000;
const DEFAULT_ACCOUNT_POLL_MS = 250;

export interface IssuerServiceConfig {
  rootAccount: string;
  requiredDepositYocto: bigint;
  accountWaitMs: number;
  accountPollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface IssuerServiceDeps {
  issuerNear: NearClientLike;
  relayNear: NearClientLike;
  credit: StorageCreditReader;
  sponsor?: SponsorStatusReader;
  /** Predicts the next claim id. Without it `prepareIssue` reports no id. */
  tokens?: TokenCounter;
  accounts: AccountChecker;
  config?: Partial<IssuerServiceConfig>;
  logger: Logger;
  indexer?: IndexerControl;
}

/** A tiny promise-chain mutex; keeps nonce use and account waits serial. */
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
  private readonly credit: StorageCreditReader;
  private readonly sponsor: SponsorStatusReader | undefined;
  private readonly tokens: TokenCounter | undefined;
  /** The highest claim number this service has seen minted. */
  private highWater = 0;
  private readonly accounts: AccountChecker;
  private readonly config: IssuerServiceConfig;
  private readonly logger: Logger;
  private readonly indexer: IndexerControl | undefined;
  private readonly mutex = new Mutex();

  constructor(deps: IssuerServiceDeps) {
    this.issuerNear = deps.issuerNear;
    this.relayNear = deps.relayNear;
    this.credit = deps.credit;
    this.sponsor = deps.sponsor;
    this.tokens = deps.tokens;
    this.accounts = deps.accounts;
    this.logger = deps.logger;
    this.indexer = deps.indexer;
    this.config = {
      rootAccount: deps.config?.rootAccount ?? "",
      requiredDepositYocto: deps.config?.requiredDepositYocto ?? REQUIRED_ISSUE_DEPOSIT_YOCTO,
      accountWaitMs: deps.config?.accountWaitMs ?? DEFAULT_ACCOUNT_WAIT_MS,
      accountPollMs: deps.config?.accountPollMs ?? DEFAULT_ACCOUNT_POLL_MS,
      now: deps.config?.now ?? Date.now,
      sleep: deps.config?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  /**
   * Reports the business's storage credit and the account/amount to top up. The token id is
   * deliberately not predicted; it comes from the `issue_for` result.
   */
  async prepareIssue(business: string): Promise<PrepareIssueResult> {
    return this.mutex.run(async () => {
      const credit = await this.credit.storageCreditOf(business);
      let sponsor: SponsorStatus | undefined;
      let sponsorFailed = false;
      if (this.sponsor !== undefined) {
        try {
          sponsor = await this.sponsor.sponsorStatusOf(business);
        } catch (error) {
          sponsorFailed = true;
          this.logger.warn(
            "sponsor_status unavailable; treating as no sponsorship",
            errorMessage(error),
          );
        }
      }
      const required = this.config.requiredDepositYocto;
      const sponsored =
        sponsor === undefined
          ? sponsorFailed
            ? false
            : undefined
          : credit < required && sponsor.pool >= required && sponsor.used < sponsor.cap;
      let predicted: { tokenId: string; claimAccount: string } | undefined;
      if (this.tokens !== undefined) {
        const next = Math.max(await this.tokens.nextTokenId(), this.highWater + 1);
        predicted = {
          tokenId: `c-${next}`,
          claimAccount: `c-${next}.${this.config.rootAccount}`,
        };
      }
      this.logger.info("prepared issue", business);
      return {
        account: this.config.rootAccount,
        amount: this.config.requiredDepositYocto.toString(),
        storageCredit: credit.toString(),
        ...(sponsored === undefined
          ? {}
          : {
              sponsored,
              sponsorPool: sponsor?.pool.toString(),
              sponsorCap: sponsor?.cap,
              sponsorUsed: sponsor?.used,
              sponsoredRemaining: Math.max(0, (sponsor?.cap ?? 0) - (sponsor?.used ?? 0)),
            }),
        ...(predicted ?? {}),
      };
    });
  }

  /** Signs `issue_for`, derives the claim account from its result and waits for it. */
  async issueFor(
    request: IssueForRequest,
  ): Promise<{ txHash: string; tokenId: string; claimAccount: string }> {
    return this.mutex.run(async () => {
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

      const tokenId = returnStringOf(result);
      if (!/^c-\d+$/.test(tokenId)) {
        throw new IssuerError(502, "NEAR_RETURN_INVALID");
      }
      this.highWater = Math.max(this.highWater, Number(tokenId.slice(2)));
      if (request.expectedTokenId !== undefined && request.expectedTokenId !== tokenId) {
        // The claim exists but its terms name another account: the caller must start again with the new count.
        throw new IssuerError(
          409,
          "TOKEN_ID_MISMATCH",
          `expected ${request.expectedTokenId}, minted ${tokenId}`,
        );
      }
      const claimAccount = `${tokenId}.${this.config.rootAccount}`;
      await this.waitForAccount(claimAccount);
      const txHash = txHashOf(result);
      try {
        await this.indexer?.registerTx(txHash);
        await this.indexer?.poke();
      } catch (error) {
        this.logger.warn("indexer control failed", errorMessage(error));
      }
      this.logger.info("issued", tokenId, request.business);
      return { txHash, tokenId, claimAccount };
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
