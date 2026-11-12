/** Settle payout worker: quote -> check recipient -> settle_payout -> status -> report_payout. */
import { calculatePeriodEndUtc } from "./schedule.js";
import type {
  ChainPort,
  CheckoutRefundEvent,
  HeldDiscovery,
  PayoutSettings,
  HeldEntry,
  QuotePort,
  StatusPort,
  WorkerSummary,
} from "./types.js";

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface PayoutWorkerDeps {
  discovery: HeldDiscovery;
  chain: ChainPort;
  quote: QuotePort;
  status: StatusPort;
  logger: Logger;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  settleRecheckMs?: number;
  /** A token with nothing left to do is read again only after this long (default 6 h), or at once when a new `settle_held` event shows up for it. */
  idleRecheckMs?: number;
  /** A token whose held share is waiting (manual, or not due yet) is read again after this long at most (default 5 min). */
  waitingRecheckMs?: number;
  alert?: (message: string, data?: Record<string, unknown>) => void;
  settings?: { forToken(tokenId: string): Promise<PayoutSettings | null> };
}

function statusName(status: HeldEntry["status"]): string {
  return typeof status === "string" ? status : (Object.keys(status)[0] ?? "unknown");
}

function inFlightId(status: HeldEntry["status"]): number | null {
  return typeof status === "object" && status !== null && "InFlight" in status
    ? status.InFlight.payout_id
    : null;
}

export class PayoutWorker {
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly recheckMs: number;
  private readonly uncertain = new Set<string>();
  private readonly firstSeen = new Map<string, number>();
  /** When each token may be read again. The worker used to read every token every tick: 15 s x 2 tokens used the day's 380 calls in half an hour (12 Nov). */
  private readonly nextRead = new Map<string, number>();
  /** For a token with nothing to do: the number of `settle_held` events it had when it was last read. */
  private readonly finalAt = new Map<string, number>();
  private readonly idleMs: number;
  private readonly waitingMs: number;

  constructor(private readonly deps: PayoutWorkerDeps) {
    this.clock = deps.clock ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.recheckMs = deps.settleRecheckMs ?? 6_000;
    this.idleMs = deps.idleRecheckMs ?? 6 * 60 * 60_000;
    this.waitingMs = deps.waitingRecheckMs ?? 5 * 60_000;
  }

  private key(tokenId: string, index: number): string {
    return `${tokenId}#${index}`;
  }

  async tick(): Promise<WorkerSummary> {
    const summary: WorkerSummary = {
      tokens: 0,
      held: 0,
      sent: [],
      settled: [],
      refunded: [],
      skipped: [],
      errors: [],
    };
    const tokens = [...new Set(await this.deps.discovery.tokens())];
    summary.tokens = tokens.length;

    const counts = (this.deps.discovery as { counts?: ReadonlyMap<string, number> }).counts;
    for (const tokenId of tokens) {
      // Nothing left to do and no new `settle_held` event since: not read again (no RPC call at all).
      const seen = this.finalAt.get(tokenId);
      if (seen !== undefined && counts !== undefined && (counts.get(tokenId) ?? 0) <= seen) {
        summary.skipped.push(`${tokenId}: all shares final`);
        await this.processCheckoutRefunds(tokenId, summary);
        continue;
      }
      if (seen !== undefined) {
        this.finalAt.delete(tokenId);
        this.nextRead.delete(tokenId);
      }
      const due = this.nextRead.get(tokenId);
      if (due !== undefined && this.clock() < due) {
        // The held shares are not read again yet (that is the RPC call); a checkout refund is still looked for.
        summary.skipped.push(`${tokenId}: not read again until ${new Date(due).toISOString()}`);
        await this.processCheckoutRefunds(tokenId, summary);
        continue;
      }
      let settings: PayoutSettings | null = null;
      try {
        settings = (await this.deps.settings?.forToken(tokenId)) ?? null;
      } catch (error) {
        summary.errors.push(`${tokenId}: payout_settings: ${String(error)}`);
      }
      let entries: HeldEntry[];
      try {
        entries = await this.deps.chain.settleHeld(tokenId);
      } catch (error) {
        summary.errors.push(`${tokenId}: settle_held: ${String(error)}`);
        continue;
      }
      // Read again at once while something moves; later when nothing does.
      let wait: number | null = this.idleMs;
      const readAgainIn = (ms: number | null) => {
        if (ms === null) wait = null;
        else if (wait !== null) wait = Math.min(wait, ms);
      };
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        const name = statusName(entry.status);
        if (name !== "Held" && name !== "InFlight") continue;
        summary.held += 1;
        if (name === "InFlight") {
          readAgainIn(null);
          const payoutId = inFlightId(entry.status);
          if (payoutId === null) continue;
          await this.finishInFlight(tokenId, index, payoutId, summary);
          continue;
        }
        const key = this.key(tokenId, index);
        if (this.uncertain.has(key)) {
          readAgainIn(60_000);
          summary.skipped.push(`${key}: send state uncertain`);
          continue;
        }
        const schedule = settings?.schedule ?? "each_payment";
        if (schedule === "manual") {
          readAgainIn(this.waitingMs);
          summary.skipped.push(`${key}: payout schedule manual`);
          continue;
        }
        const bookedAt = this.firstSeen.get(key) ?? entry.bookedAtUtc ?? this.clock();
        this.firstSeen.set(key, bookedAt);
        const end = calculatePeriodEndUtc(bookedAt, schedule);
        if (end !== null && this.clock() < end) {
          readAgainIn(Math.min(this.waitingMs, end - this.clock()));
          summary.skipped.push(`${key}: not due for schedule ${schedule}`);
          continue;
        }
        await this.startPayout(tokenId, index, entry, summary, settings?.destination ?? undefined);
        // A payout was started: follow it on the next tick.
        readAgainIn(null);
      }
      if (wait === null) this.nextRead.delete(tokenId);
      else if (wait === this.idleMs && counts !== undefined)
        this.finalAt.set(tokenId, counts.get(tokenId) ?? 0);
      else this.nextRead.set(tokenId, this.clock() + wait);
      await this.processCheckoutRefunds(tokenId, summary);
    }
    return summary;
  }

  private async processCheckoutRefunds(tokenId: string, summary: WorkerSummary): Promise<void> {
    if (this.deps.chain.checkoutRefundEvents === undefined) return;
    let refunds: CheckoutRefundEvent[];
    try {
      refunds = await this.deps.chain.checkoutRefundEvents(tokenId);
    } catch (error) {
      summary.errors.push(`${tokenId}: checkout_refund: ${String(error)}`);
      return;
    }
    for (let index = 0; index < refunds.length; index += 1) {
      const refund = refunds[index];
      if (refund === undefined) continue;
      const key = `checkout:${tokenId}#${index}`;
      const status = refund.status;
      if (typeof status === "object" && status !== null && "InFlight" in status) {
        await this.finishInFlight(tokenId, index, status.InFlight.payout_id, summary);
        continue;
      }
      if (typeof status === "object" && status !== null && "Settled" in status) continue;
      if (this.uncertain.has(key)) {
        summary.skipped.push(`${key}: send state uncertain`);
        continue;
      }
      await this.startCheckoutRefund(refund, index, key, summary);
    }
  }

  private async startCheckoutRefund(
    refund: CheckoutRefundEvent,
    index: number,
    key: string,
    summary: WorkerSummary,
  ): Promise<void> {
    try {
      if (this.deps.chain.bookedNet !== undefined) {
        const net = await this.deps.chain.bookedNet(refund.tokenId);
        if (BigInt(refund.amount) > BigInt(net)) {
          const message = `${key}: refund amount ${refund.amount} exceeds booked net ${net}`;
          summary.errors.push(message);
          this.deps.logger.error(message);
          this.deps.alert?.(message, {
            token_id: refund.tokenId,
            amount: refund.amount,
            booked_net: net,
          });
          return;
        }
      }
      const refundTo = await this.deps.chain.claimAccount(refund.tokenId);
      const destination = { chain: "auto", address: refund.refundTo, min_amount: "0" };
      const quote = await this.deps.quote.quote({
        asset: refund.asset,
        amount: refund.amount,
        destination,
        refundTo,
        deadline: new Date(this.clock() + 60 * 60 * 1000).toISOString(),
      });
      await this.sleep(this.recheckMs);
      const fresh = await this.deps.chain.checkoutRefundEvents?.(refund.tokenId);
      const current = fresh?.[index];
      if (
        current?.status !== undefined &&
        typeof current.status === "object" &&
        current.status !== null &&
        "InFlight" in current.status
      ) {
        summary.skipped.push(`${key}: became InFlight before send`);
        return;
      }
      if (quote.recipient !== refund.refundTo) {
        const message = `${key}: quote recipient mismatch (expected ${refund.refundTo}, got ${quote.recipient})`;
        summary.errors.push(message);
        this.deps.logger.error("quote recipient mismatch", key, quote.recipient, refund.refundTo);
        this.deps.alert?.(message, {
          token_id: refund.tokenId,
          quote_recipient: quote.recipient,
          refund_to: refund.refundTo,
        });
        return;
      }
      try {
        const result =
          this.deps.chain.refundLate !== undefined
            ? await this.deps.chain.refundLate(refund.tokenId, quote.depositAddress, quote.amountIn)
            : await this.deps.chain.settlePayout(
                refund.tokenId,
                index,
                quote.depositAddress,
                quote.amountIn,
              );
        summary.sent.push(`${key}:${result.payoutId}`);
        this.deps.logger.info("checkout refund sent", key, result.payoutId, result.txHash);
      } catch (error) {
        this.uncertain.add(key);
        summary.errors.push(`${key}: refund_late: ${String(error)}`);
      }
    } catch (error) {
      summary.errors.push(`${key}: ${String(error)}`);
    }
  }

  private async startPayout(
    tokenId: string,
    index: number,
    entry: HeldEntry,
    summary: WorkerSummary,
    expectedDestination?: string,
  ): Promise<void> {
    const key = this.key(tokenId, index);
    try {
      const destination = await this.deps.chain.settlementOf(entry.owner);
      if (destination === null) {
        summary.skipped.push(`${key}: no destination`);
        return;
      }
      if (expectedDestination !== undefined && destination.address !== expectedDestination) {
        summary.errors.push(`${key}: destination mismatch`);
        this.deps.alert?.("payout destination mismatch", {
          token_id: tokenId,
          expected: expectedDestination,
          on_chain: destination.address,
        });
        return;
      }
      if (destination.chain === "confidential" && destination.address !== entry.owner) {
        summary.errors.push(`${key}: confidential destination is not the owner`);
        this.deps.alert?.("confidential destination is not the owner", {
          token_id: tokenId,
          owner: entry.owner,
          destination: destination.address,
        });
        return;
      }
      if (BigInt(entry.amount) < BigInt(destination.min_amount)) {
        summary.errors.push(`${key}: amount below destination minimum`);
        this.deps.alert?.("payout amount below destination minimum", {
          token_id: tokenId,
          amount: entry.amount,
          minimum: destination.min_amount,
        });
        return;
      }
      const refundTo = await this.deps.chain.claimAccount(tokenId);
      const quote = await this.deps.quote.quote({
        asset: entry.asset,
        amount: entry.amount,
        destination,
        refundTo,
        deadline: new Date(this.clock() + 60 * 60 * 1000).toISOString(),
      });
      // A previous send may have reached the chain just before a restart. Wait a few blocks
      // and re-read the entry; never send if it has moved to InFlight.
      await this.sleep(this.recheckMs);
      const fresh = await this.deps.chain.settleHeld(tokenId);
      const current = fresh[index];
      if (current !== undefined && statusName(current.status) !== "Held") {
        summary.skipped.push(`${key}: became ${statusName(current.status)} before send`);
        return;
      }
      // The contract cannot verify the deposit address; the service checks the quote before sending.
      if (quote.recipient !== destination.address) {
        summary.errors.push(`${key}: quote recipient mismatch`);
        this.deps.logger.error(
          "quote recipient mismatch",
          key,
          quote.recipient,
          destination.address,
        );
        return;
      }
      if (quote.amountIn !== entry.amount) {
        summary.errors.push(`${key}: quote amount mismatch`);
        this.deps.alert?.("payout quote amount mismatch", {
          token_id: tokenId,
          amount: entry.amount,
          quote_amount: quote.amountIn,
        });
        return;
      }
      try {
        const result = await this.deps.chain.settlePayout(
          tokenId,
          index,
          quote.depositAddress,
          quote.amountIn,
        );
        summary.sent.push(`${key}:${result.payoutId}`);
        this.deps.logger.info("settle_payout sent", key, result.payoutId, result.txHash);
      } catch (error) {
        // The call may have reached the chain. The outbox/on-chain InFlight state is the truth;
        // never send the same held entry again in this process.
        this.uncertain.add(key);
        summary.errors.push(`${key}: settle_payout: ${String(error)}`);
      }
    } catch (error) {
      summary.errors.push(`${key}: ${String(error)}`);
    }
  }

  private async finishInFlight(
    tokenId: string,
    index: number,
    payoutId: number,
    summary: WorkerSummary,
  ): Promise<void> {
    const key = this.key(tokenId, index);
    try {
      const payout = await this.deps.chain.payout(payoutId);
      if (payout === null) {
        summary.skipped.push(`${key}: payout ${payoutId} not found`);
        return;
      }
      const current = await this.deps.status.status(payout.deposit_address);
      const status = current.status.toUpperCase();
      if (
        status === "PENDING_DEPOSIT" ||
        status === "KNOWN_DEPOSIT_TX" ||
        status === "PROCESSING"
      ) {
        summary.skipped.push(`${key}: ${status}`);
        return;
      }
      if (status === "SUCCESS") {
        const hash = current.destinationTxHashes[0]?.hash ?? current.nearTxHashes?.[0];
        if (hash === undefined || hash === "") {
          summary.errors.push(`${key}: SUCCESS without destination tx`);
          return;
        }
        if (payout.module_id === "checkout") {
          summary.settled.push(`${key}:${hash}`);
          return;
        }
        await this.deps.chain.reportPayout(tokenId, index, payoutId, {
          Settled: { destination_tx: hash },
        });
        summary.settled.push(`${key}:${hash}`);
        return;
      }
      if (status === "REFUNDED" || status === "FAILED") {
        if (payout.module_id === "checkout") {
          summary.refunded.push(`${key}:${status}`);
          return;
        }
        if (current.refundedAmount === undefined || current.refundedAmount === "") {
          const message = `refund amount missing for ${key} (payout ${payoutId})`;
          this.deps.logger.error(message);
          this.deps.alert?.(message, { token_id: tokenId, index, payout_id: payoutId });
          summary.errors.push(`${key}: refund amount missing`);
          return;
        }
        await this.deps.chain.reportPayout(tokenId, index, payoutId, {
          Refunded: { amount: current.refundedAmount },
        });
        summary.refunded.push(`${key}:${status}`);
        return;
      }
      summary.skipped.push(`${key}: ${status}`);
    } catch (error) {
      summary.errors.push(`${key}: ${String(error)}`);
    }
  }
}
