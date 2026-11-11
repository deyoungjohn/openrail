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
import {
  DEFAULT_BALANCE_CHECK_MS,
  DEFAULT_BLOCK_CACHE_MS,
  DEFAULT_COOL_INTERVAL_MS,
  DEFAULT_DISCOVER_CACHE_MS,
  DEFAULT_HOT_WINDOW_MS,
  DEFAULT_IDLE_PROBE_MS,
  DEFAULT_WARM_INTERVAL_MS,
  DEFAULT_WARM_WINDOW_MS,
  type WatcherConfig,
} from "./config.js";
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
/** After sending `clear_stale_lock` for a claim, wait this long before sending it again. */
const CLEAR_BACKOFF_MS = 120_000;
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

function nextIssuerFrom(_page: ClaimView[], fallback: number): number {
  // Labels are not ordered by number, so the issuer feed advances by page size; labelled claims
  // are still enumerated by nft_tokens below.
  return fallback + PAGE_SIZE;
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
  /** Finished claims and when they were last looked at: late payments to them are booked as surplus for the business. */
  private readonly finished = new Map<string, number>();
  /** When `clear_stale_lock` was last sent for a claim: a module may refuse it (a payout still out), so do not repeat it every tick. */
  private readonly clearedAt = new Map<string, number>();
  /** When each claim is next due, and the last view of it (so an idle claim costs no call until it is due). */
  private readonly dueAt = new Map<string, number>();
  private readonly knownClaims = new Map<string, ClaimView>();
  private readonly knownAt = new Map<string, number>();
  private readonly lastInterval = new Map<string, number>();
  private lastDiscoverAt = 0;
  private lastClaims: ClaimView[] = [];
  private lastBlockAt = 0;
  private lastBalanceAt = 0;
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
      rpc_calls: {
        ...(this.near.callCounts?.() ?? {}),
        ...(this.chain.callCounts?.() ?? {}),
      },
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
          if (typeof id !== "string" || claims.has(id)) continue;
          // A claim that is not due again yet is not read again: the view of it from the last time stays in the list.
          const known = this.knownClaims.get(id);
          const dueAt = this.dueAt.get(id);
          const readAt = this.knownAt.get(id) ?? 0;
          const interval = this.lastInterval.get(id) ?? 0;
          // Not due yet, or not hot and its view is under ten minutes old: the last view stands (a claim's status
          // does not change by itself, and a hot one is read every tick).
          if (
            known !== undefined &&
            ((dueAt !== undefined && this.now() < dueAt) ||
              (interval > this.config.fastIntervalMs && this.now() - readAt < 600_000))
          ) {
            claims.set(id, known);
            continue;
          }
          const claim = await this.near.view<ClaimView | null>({
            contractId: this.config.rootAccount,
            methodName: "claim",
            args: { token_id: id },
            feature: "watcher:claim",
          });
          if (claim === null || typeof claim?.token_id !== "string") continue;
          if (TERMINAL_STATUSES.has(claim.status)) this.finished.set(id, this.now());
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

  /**
   * How long until a claim is looked at again, from its last quote (seconds since the epoch, `null` for none).
   * Hot (the quote is open or at most an hour past): the fast cadence. Then a read a minute until 24 h past, every
   * five minutes until the quote TTL, and the slow cadence after. A claim nobody has priced is probed once a minute
   * for its first quote. (The blueprint's 72 h of 15 s polling read every priced claim 5,760 times a day.)
   */
  private intervalFor(lastQuoteSec: number | null, nowMs: number, finished: boolean): number {
    const c = this.config;
    if (lastQuoteSec === null)
      return finished ? c.slowIntervalMs : (c.idleProbeMs ?? DEFAULT_IDLE_PROBE_MS);
    const age = nowMs - lastQuoteSec * 1000;
    if (age <= (c.hotWindowMs ?? DEFAULT_HOT_WINDOW_MS)) return c.fastIntervalMs;
    if (age <= (c.warmWindowMs ?? DEFAULT_WARM_WINDOW_MS)) {
      return c.warmIntervalMs ?? DEFAULT_WARM_INTERVAL_MS;
    }
    if (age <= c.quoteTtlMs) return c.coolIntervalMs ?? DEFAULT_COOL_INTERVAL_MS;
    return c.slowIntervalMs;
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
      const last = this.clearedAt.get(claim.token_id);
      if (last !== undefined && this.now() - last < CLEAR_BACKOFF_MS) return;
      this.clearedAt.set(claim.token_id, this.now());
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

  /**
   * The API says a price was just asked for this claim: look at it on the next tick, whatever its cadence, and list
   * the claims again (a claim issued a moment ago is not in the cached list). A decided claim stays decided.
   */
  poke(tokenId: string): void {
    const claim = this.knownClaims.get(tokenId);
    if (claim !== undefined && !isNonTerminal(claim.status)) return;
    this.dueAt.delete(tokenId);
    this.lastInterval.delete(tokenId);
    this.lastDiscoverAt = 0;
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

    // The block height is only needed to judge a lock: read it once a minute, or each tick while a claim holds one.
    const lockHeld = this.lastClaims.some((claim) => !isNoneLock(claim.lock));
    if (
      this.lastBlockHeight === null ||
      lockHeld ||
      nowMs - this.lastBlockAt >= (this.config.blockCacheMs ?? DEFAULT_BLOCK_CACHE_MS)
    ) {
      try {
        this.lastBlockHeight = await this.chain.blockHeight();
        this.lastBlockAt = nowMs;
      } catch (error) {
        this.noteError(error);
      }
    }
    if (
      this.lastBalanceYocto === null ||
      nowMs - this.lastBalanceAt >= (this.config.balanceCheckMs ?? DEFAULT_BALANCE_CHECK_MS)
    ) {
      await this.checkBalance(nowMs);
      this.lastBalanceAt = nowMs;
    }

    let claims: ClaimView[];
    try {
      // With nothing hot the list of claims is read once a minute: a claim that gets its first quote is seen by the
      // probe below, and the listing itself (config, issuers, every token) costs several calls.
      const configured = this.config.discoverCacheMs ?? DEFAULT_DISCOVER_CACHE_MS;
      // Half a minute while a claim is hot (a new quote is seen sooner), a minute otherwise.
      const cacheMs = this.fastClaims > 0 ? Math.min(configured, 30_000) : configured;
      if (this.lastClaims.length > 0 && nowMs - this.lastDiscoverAt < cacheMs) {
        claims = this.lastClaims;
      } else {
        claims = await this.discoverClaims();
        this.lastClaims = claims;
        this.lastDiscoverAt = nowMs;
      }
    } catch (error) {
      this.noteError(error);
      this.lastTickAt = nowMs;
      return summary;
    }

    summary.claims = claims.length;
    this.claimsTracked = claims.length;

    for (const claim of claims) {
      // Not due yet: no call at all for this claim (its last view stays in the list).
      const due = this.dueAt.get(claim.token_id);
      if (due !== undefined && nowMs < due) {
        summary.skipped += 1;
        continue;
      }
      const finished = !isNonTerminal(claim.status);
      let lastQuote: number | null = null;
      let quoteKnown = true;
      if (!finished) {
        try {
          lastQuote = await this.lastQuoteDeadline(claim.token_id);
        } catch (error) {
          // Unknown quote age must not hide a payment: keep the hot cadence and process it.
          this.noteError(error);
          quoteKnown = false;
        }
      }
      const interval = quoteKnown
        ? this.intervalFor(lastQuote, nowMs, finished)
        : this.config.fastIntervalMs;
      const quoteExpiryMs = lastQuote === null ? null : lastQuote * 1000 + this.config.quoteTtlMs;
      const openQuote = quoteExpiryMs !== null && nowMs <= quoteExpiryMs;
      const blockHeight = this.lastBlockHeight;
      const lockExpired = this.lockExpired(claim.lock, blockHeight);
      const hasWork =
        openQuote ||
        finished ||
        isNonTerminal(claim.status) ||
        (Array.isArray(claim.undistributed) && claim.undistributed.length > 0) ||
        lockExpired;

      // A claim that is Paid, Cancelled or Closed is decided for good (the human's rule, 11 Nov): looked at once, then
      // never again. Money that reaches its account later stays there until someone calls the permissionless `reconcile`.
      this.dueAt.set(claim.token_id, finished ? Number.POSITIVE_INFINITY : nowMs + interval);
      this.knownClaims.set(claim.token_id, claim);
      this.knownAt.set(claim.token_id, nowMs);
      this.lastInterval.set(claim.token_id, interval);
      if (!hasWork) continue;
      if (interval > this.config.fastIntervalMs) summary.slow += 1;
      else summary.fast += 1;
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
