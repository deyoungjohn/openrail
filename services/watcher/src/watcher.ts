/**
 * Watcher core (blueprint 1.6, 2.5, 2.9).
 *
 * Every tick:
 *  - reads `config()` and `claims_by_issuer` (plus optional extra claims) to discover claims;
 *  - reads each claim's `payment_log` for the last quote deadline;
 *  - batches `mt_batch_balance_of` for the claims that are hot or due on the slow cadence;
 *  - sends exactly one of `reconcile` (any rise), `retry_distribution` (undistributed legs),
 *    `clear_stale_lock` (expired lock) per claim per tick;
 *  - reads the watcher balance and alerts below the threshold.
 *
 * After a claim's last quote +72 h it moves to the 10-minute cadence. Every contract call goes
 * through the public core methods named in `abi/openrail.core.json`.
 */
import { redactString, type IndexerControl, type Logger } from "@openrail/shared";
import type { AlertSink, LowBalanceAlert } from "./alerts.js";
import type { WatcherConfig } from "./config.js";
import type { HealthSnapshot } from "./health.js";
import { WATCHER_GAS, WATCHER_METHODS, type WatcherMethod } from "./methods.js";
import type {
  ChainStatus,
  ClaimLock,
  ClaimView,
  ConfigView,
  NearClientLike,
  Quote,
} from "./types.js";

const PAGE_SIZE = 100;
const RECONCILING_BLOCKS = 100;
const YOCTO_PER_NEAR = 1_000_000_000_000_000_000_000_000n;

const TERMINAL_STATUSES = new Set(["Paid", "Cancelled", "Closed"]);

export interface TickSummary {
  claims: number;
  fast: number;
  slow: number;
  skipped: number;
  reconciled: string[];
  retried: string[];
  cleared: string[];
}

export interface WatcherOptions {
  near: NearClientLike;
  chain: ChainStatus;
  config: WatcherConfig;
  logger: Logger;
  alert: AlertSink;
  /** Called when the balance first drops below the threshold (write a report). */
  reportLowBalance?: (snapshot: HealthSnapshot) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  indexer?: IndexerControl;
}

function isNonTerminal(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gasFor(method: WatcherMethod): bigint {
  switch (method) {
    case WATCHER_METHODS.reconcile:
      return WATCHER_GAS.reconcile;
    case WATCHER_METHODS.retryDistribution:
      return WATCHER_GAS.retryDistribution;
    case WATCHER_METHODS.clearStaleLock:
      return WATCHER_GAS.clearStaleLock;
  }
}

function isNoneLock(lock: ClaimLock): boolean {
  return lock === "None" || (typeof lock === "object" && lock !== null && "None" in lock);
}

function nextIssuerFrom(page: ClaimView[], fallback: number): number {
  let highest = 0;
  for (const claim of page) {
    const match = /^c-(\d+)$/.exec(claim.token_id);
    if (match?.[1] !== undefined) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) highest = Math.max(highest, value);
    }
  }
  return highest > 0 ? highest + 1 : fallback + PAGE_SIZE;
}

export class Watcher {
  private readonly near: NearClientLike;
  private readonly chain: ChainStatus;
  private readonly config: WatcherConfig;
  private readonly logger: Logger;
  private readonly alert: AlertSink;
  private readonly reportLowBalance: ((snapshot: HealthSnapshot) => void) | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly indexer: IndexerControl | undefined;

  private readonly lastChecked = new Map<string, number>();
  private readonly finished = new Set<string>();
  private lowAlerted = false;
  private belowThreshold = false;
  private lastBlockHeight: number | null = null;
  private lastBalanceYocto: bigint | null = null;
  private lastBalanceNear: number | null = null;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private claimsTracked = 0;
  private fastClaims = 0;
  private slowClaims = 0;

  constructor(options: WatcherOptions) {
    this.near = options.near;
    this.chain = options.chain;
    this.config = options.config;
    this.logger = options.logger;
    this.alert = options.alert;
    this.reportLowBalance = options.reportLowBalance;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.indexer = options.indexer;
  }

  snapshot(): HealthSnapshot {
    return {
      status: this.belowThreshold ? "degraded" : "ok",
      last_block_height: this.lastBlockHeight,
      near_balance_yocto: this.lastBalanceYocto === null ? null : this.lastBalanceYocto.toString(),
      near_balance_near: this.lastBalanceNear,
      min_balance_near: this.config.minBalanceNear,
      claims_tracked: this.claimsTracked,
      fast_claims: this.fastClaims,
      slow_claims: this.slowClaims,
      last_tick_at: this.lastTickAt === null ? null : new Date(this.lastTickAt).toISOString(),
      last_error: this.lastError,
    };
  }

  private noteError(error: unknown): void {
    const message = redactString(errorMessage(error));
    this.lastError = message;
    this.logger.warn("watcher error", message);
  }

  private async discoverClaims(): Promise<ClaimView[]> {
    const config = await this.near.view<ConfigView>({
      contractId: this.config.rootAccount,
      methodName: "config",
      args: {},
      feature: "watcher:config",
    });
    const claims = new Map<string, ClaimView>();

    const issuers = Array.isArray(config.issuers) ? config.issuers : [];
    for (const issuer of issuers) {
      let from = 1;
      for (;;) {
        const page = await this.near.view<ClaimView[]>({
          contractId: this.config.rootAccount,
          methodName: "claims_by_issuer",
          args: { account: issuer, from, limit: PAGE_SIZE },
          feature: "watcher:claims",
        });
        if (!Array.isArray(page) || page.length === 0) break;
        for (const claim of page) {
          if (typeof claim?.token_id === "string") claims.set(claim.token_id, claim);
        }
        if (page.length < PAGE_SIZE) break;
        from = nextIssuerFrom(page, from);
      }
    }

    // Claims are issued for businesses (issuer_id = the business), so the issuer list alone misses them:
    // walk every minted token too. Finished claims are remembered and not read again.
    try {
      let fromIndex = 0;
      for (;;) {
        const tokens = await this.near.view<Array<{ token_id?: unknown }>>({
          contractId: this.config.rootAccount,
          methodName: "nft_tokens",
          args: { from_index: String(fromIndex), limit: PAGE_SIZE },
          feature: "watcher:tokens",
        });
        if (!Array.isArray(tokens) || tokens.length === 0) break;
        for (const token of tokens) {
          const id = token?.token_id;
          if (typeof id !== "string" || claims.has(id) || this.finished.has(id)) continue;
          const claim = await this.near.view<ClaimView | null>({
            contractId: this.config.rootAccount,
            methodName: "claim",
            args: { token_id: id },
            feature: "watcher:claim",
          });
          if (claim === null || typeof claim?.token_id !== "string") continue;
          if (TERMINAL_STATUSES.has(claim.status) && !(claim.undistributed?.length ?? 0)) {
            this.finished.add(id);
            continue;
          }
          claims.set(claim.token_id, claim);
        }
        if (tokens.length < PAGE_SIZE) break;
        fromIndex += tokens.length;
      }
    } catch (error) {
      this.noteError(error);
    }

    for (const tokenId of this.config.extraClaims) {
      if (claims.has(tokenId)) continue;
      const claim = await this.near.view<ClaimView | null>({
        contractId: this.config.rootAccount,
        methodName: "claim",
        args: { token_id: tokenId },
        feature: "watcher:claim",
      });
      if (claim !== null && typeof claim?.token_id === "string") {
        claims.set(claim.token_id, claim);
      }
    }

    return [...claims.values()];
  }

  private async lastQuoteDeadline(tokenId: string): Promise<number | null> {
    let from = 0;
    let last: number | null = null;
    for (;;) {
      const page = await this.near.view<Quote[]>({
        contractId: this.config.rootAccount,
        methodName: "payment_log",
        args: { token_id: tokenId, from, limit: PAGE_SIZE },
        feature: "watcher:quotes",
      });
      if (!Array.isArray(page) || page.length === 0) break;
      for (const quote of page) {
        const deadline = Number(quote.deadline_requested);
        if (Number.isFinite(deadline)) {
          last = last === null ? deadline : Math.max(last, deadline);
        }
      }
      if (page.length < PAGE_SIZE) break;
      from += page.length;
    }
    return last;
  }

  private lockExpired(lock: ClaimLock, blockHeight: number | null): boolean {
    if (blockHeight === null || isNoneLock(lock)) return false;
    if (typeof lock !== "object" || lock === null) return false;
    if ("Reconciling" in lock) {
      return blockHeight > lock.Reconciling.since + RECONCILING_BLOCKS;
    }
    if ("TransferWindow" in lock) {
      return blockHeight > lock.TransferWindow.until;
    }
    if ("Module" in lock) {
      return blockHeight > lock.Module.until;
    }
    return false;
  }

  private hasRise(claim: ClaimView, balances: string[]): boolean {
    return claim.settlement_assets.some((asset, index) => {
      const seen = BigInt(claim.last_seen_balance?.[asset] ?? "0");
      const current = BigInt(balances[index] ?? "0");
      return current > seen;
    });
  }

  private async send(method: WatcherMethod, tokenId: string): Promise<void> {
    const result = await this.near.sendFunctionCall({
      receiverId: this.config.rootAccount,
      methodName: method,
      args: { token_id: tokenId },
      gas: gasFor(method),
      deposit: 0n,
      feature: "watcher",
    });
    const outcome = result as {
      transaction?: { hash?: unknown };
      transaction_outcome?: { id?: unknown };
    } | null;
    const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
    try {
      if (typeof hash === "string" && hash !== "") await this.indexer?.registerTx(hash);
      await this.indexer?.poke();
    } catch (error) {
      this.logger.warn("indexer control failed", errorMessage(error));
    }
    this.logger.info("sent", method, tokenId);
  }

  private async processClaim(
    claim: ClaimView,
    blockHeight: number | null,
    summary: TickSummary,
  ): Promise<void> {
    const balances = await this.near.batchBalanceOf({
      accountId: claim.claim_account,
      tokenIds: claim.settlement_assets,
      feature: "watcher:balances",
    });

    if (this.hasRise(claim, balances)) {
      await this.send(WATCHER_METHODS.reconcile, claim.token_id);
      summary.reconciled.push(claim.token_id);
      return;
    }
    if (Array.isArray(claim.undistributed) && claim.undistributed.length > 0) {
      await this.send(WATCHER_METHODS.retryDistribution, claim.token_id);
      summary.retried.push(claim.token_id);
      return;
    }
    if (this.lockExpired(claim.lock, blockHeight)) {
      await this.send(WATCHER_METHODS.clearStaleLock, claim.token_id);
      summary.cleared.push(claim.token_id);
    }
  }

  private async checkBalance(nowMs: number): Promise<void> {
    let yocto: bigint;
    try {
      yocto = await this.chain.accountBalanceYocto(this.config.watcherAccount);
    } catch (error) {
      this.noteError(error);
      return;
    }

    this.lastBalanceYocto = yocto;
    this.lastBalanceNear = Number(yocto) / Number(YOCTO_PER_NEAR);
    const thresholdYocto = BigInt(Math.round(this.config.minBalanceNear * Number(YOCTO_PER_NEAR)));
    const low = yocto < thresholdYocto;
    this.belowThreshold = low;

    if (low && !this.lowAlerted) {
      this.lowAlerted = true;
      const alert: LowBalanceAlert = {
        service: "watcher",
        kind: "low_balance",
        account: this.config.watcherAccount,
        balance_near: this.lastBalanceNear,
        threshold_near: this.config.minBalanceNear,
        at: new Date(nowMs).toISOString(),
      };
      try {
        await this.alert(alert);
        this.logger.warn("low balance alert", `${alert.balance_near} NEAR`);
      } catch (error) {
        this.noteError(error);
      }
      try {
        this.reportLowBalance?.(this.snapshot());
      } catch (error) {
        this.noteError(error);
      }
    } else if (!low) {
      this.lowAlerted = false;
    }
  }

  /** One poll. Exposed so tests (and operators) can run a single tick. */
  async tick(): Promise<TickSummary> {
    const nowMs = this.now();
    const summary: TickSummary = {
      claims: 0,
      fast: 0,
      slow: 0,
      skipped: 0,
      reconciled: [],
      retried: [],
      cleared: [],
    };

    try {
      this.lastBlockHeight = await this.chain.blockHeight();
    } catch (error) {
      this.noteError(error);
    }
    await this.checkBalance(nowMs);

    let claims: ClaimView[];
    try {
      claims = await this.discoverClaims();
    } catch (error) {
      this.noteError(error);
      this.lastTickAt = nowMs;
      return summary;
    }

    summary.claims = claims.length;
    this.claimsTracked = claims.length;

    for (const claim of claims) {
      let lastQuote: number | null = null;
      try {
        lastQuote = await this.lastQuoteDeadline(claim.token_id);
      } catch (error) {
        // Unknown quote age must not hide a payment: keep the hot cadence and process it.
        this.noteError(error);
      }

      const quoteExpiryMs = lastQuote === null ? null : lastQuote * 1000 + this.config.quoteTtlMs;
      const openQuote = quoteExpiryMs !== null && nowMs <= quoteExpiryMs;
      const slowClaim = quoteExpiryMs !== null && nowMs > quoteExpiryMs;
      const blockHeight = this.lastBlockHeight;
      const lockExpired = this.lockExpired(claim.lock, blockHeight);
      const hasWork =
        openQuote ||
        isNonTerminal(claim.status) ||
        (Array.isArray(claim.undistributed) && claim.undistributed.length > 0) ||
        lockExpired;

      if (!hasWork) continue;
      if (slowClaim) summary.slow += 1;
      else summary.fast += 1;

      const last = this.lastChecked.get(claim.token_id) ?? 0;
      if (slowClaim && last !== 0 && nowMs - last < this.config.slowIntervalMs) {
        summary.skipped += 1;
        continue;
      }
      this.lastChecked.set(claim.token_id, nowMs);

      try {
        await this.processClaim(claim, blockHeight, summary);
      } catch (error) {
        this.noteError(error);
      }
    }

    this.fastClaims = summary.fast;
    this.slowClaims = summary.slow;
    this.lastTickAt = nowMs;
    this.logger.info(
      "tick",
      `${summary.claims} claims, ${summary.reconciled.length} reconciled, ` +
        `${summary.retried.length} retried, ${summary.cleared.length} cleared, ` +
        `${summary.skipped} skipped`,
    );
    return summary;
  }

  /** Runs ticks at the fast cadence until aborted. */
  async run(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted === true) break;
      try {
        await this.tick();
      } catch (error) {
        this.noteError(error);
      }
      await this.sleep(this.config.fastIntervalMs);
    }
  }
}
