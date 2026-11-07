/** Settle payout worker: quote -> check recipient -> settle_payout -> status -> report_payout. */
import type {
  ChainPort,
  HeldDiscovery,
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
  alert?: (message: string, data?: Record<string, unknown>) => void;
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

  constructor(private readonly deps: PayoutWorkerDeps) {
    this.clock = deps.clock ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.recheckMs = deps.settleRecheckMs ?? 6_000;
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

    for (const tokenId of tokens) {
      let entries: HeldEntry[];
      try {
        entries = await this.deps.chain.settleHeld(tokenId);
      } catch (error) {
        summary.errors.push(`${tokenId}: settle_held: ${String(error)}`);
        continue;
      }
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        const name = statusName(entry.status);
        if (name !== "Held" && name !== "InFlight") continue;
        summary.held += 1;
        if (name === "InFlight") {
          const payoutId = inFlightId(entry.status);
          if (payoutId === null) continue;
          await this.finishInFlight(tokenId, index, payoutId, summary);
          continue;
        }
        const key = this.key(tokenId, index);
        if (this.uncertain.has(key)) {
          summary.skipped.push(`${key}: send state uncertain`);
          continue;
        }
        await this.startPayout(tokenId, index, entry, summary);
      }
      await this.processCheckoutRefunds(tokenId, summary);
    }
    return summary;
  }

  /** Stub for REL-2 checkout refunds: ag4 implements against REL2-checkout-refund tests. */
  private async processCheckoutRefunds(_tokenId: string, _summary: WorkerSummary): Promise<void> {
    // stub: does nothing
  }

  private async startPayout(
    tokenId: string,
    index: number,
    entry: HeldEntry,
    summary: WorkerSummary,
  ): Promise<void> {
    const key = this.key(tokenId, index);
    try {
      const destination = await this.deps.chain.settlementOf(entry.owner);
      if (destination === null) {
        summary.skipped.push(`${key}: no destination`);
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
        const hash = current.destinationTxHashes[0]?.hash;
        if (hash === undefined || hash === "") {
          summary.errors.push(`${key}: SUCCESS without destination tx`);
          return;
        }
        await this.deps.chain.reportPayout(tokenId, index, payoutId, {
          Settled: { destination_tx: hash },
        });
        summary.settled.push(`${key}:${hash}`);
        return;
      }
      if (status === "REFUNDED" || status === "FAILED") {
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
