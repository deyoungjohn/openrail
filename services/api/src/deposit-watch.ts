/**
 * The provider tells us when money moves; the chain is read only then (13 Nov, RPC budget of 150,000 calls a week).
 *
 * For every pay session whose price is live, ask the provider's status for its deposit address (the provider's quota,
 * not an RPC call). When the word leaves `PENDING_DEPOSIT`, or changes again (PROCESSING, then SUCCESS), poke the
 * watcher: it reads that one claim on chain and books what is there. The provider's word is a trigger, never the
 * amount: the booking is what the contract reads on the claim account.
 *
 * Cadence: every 5 s per session (human, 13 Nov) until an hour after its deadline, then no more (the watcher's daily sweep covers a
 * deposit that arrives later). A 429 or a failing provider pauses the whole round for a minute.
 */
import type { PaySession, ProviderStatus } from "./quote.js";

export const DEPOSIT_ASK_EVERY_MS = 5_000;
export const DEPOSIT_GRACE_MS = 60 * 60_000;
export const DEPOSIT_PAUSE_MS = 60_000;

const FINAL_WORDS = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export interface DepositWatchDeps {
  /** Sessions not yet final (success, refunded, failed, expired). */
  openSessions: () => PaySession[];
  save: (session: PaySession) => void;
  status: (depositAddress: string) => Promise<ProviderStatus | undefined>;
  poke: (tokenId: string) => Promise<void>;
  statusOf: (word: string) => PaySession["status"];
  clock?: () => number;
}

export class DepositWatch {
  private readonly lastAsked = new Map<string, number>();
  private readonly lastWord = new Map<string, string>();
  private pausedUntil = 0;
  private asked = 0;
  private poked = 0;
  private readonly clock: () => number;

  constructor(private readonly deps: DepositWatchDeps) {
    this.clock = deps.clock ?? Date.now;
  }

  /** One round: asks the provider about every live session that is due. */
  async runOnce(): Promise<void> {
    const now = this.clock();
    if (now < this.pausedUntil) return;
    for (const session of this.deps.openSessions()) {
      if (now > session.deadline_requested * 1000 + DEPOSIT_GRACE_MS) continue;
      const last = this.lastAsked.get(session.id) ?? 0;
      if (now - last < DEPOSIT_ASK_EVERY_MS) continue;
      this.lastAsked.set(session.id, now);
      let live: ProviderStatus | undefined;
      try {
        this.asked += 1;
        live = await this.deps.status(session.deposit_address);
      } catch {
        // Rate limited or down: stop this round and wait a minute (the pay page still asks on its own).
        this.pausedUntil = now + DEPOSIT_PAUSE_MS;
        return;
      }
      if (live !== undefined) await this.observe(session, live.status);
    }
  }

  /**
   * The provider's word for a session, from this round or from the payer's page. Pokes the watcher when it changes
   * away from PENDING_DEPOSIT, and stores a final word on the session.
   */
  async observe(session: PaySession, word: string): Promise<void> {
    const before = this.lastWord.get(session.id) ?? "PENDING_DEPOSIT";
    this.lastWord.set(session.id, word);
    if (word !== before && word !== "PENDING_DEPOSIT") {
      this.poked += 1;
      await this.deps.poke(session.token_id).catch(() => undefined);
    }
    if (FINAL_WORDS.has(word)) {
      const status = this.deps.statusOf(word);
      if (status !== session.status) this.deps.save({ ...session, status });
      this.lastAsked.delete(session.id);
      this.lastWord.delete(session.id);
    }
  }

  health(): { asked: number; poked: number; paused: boolean } {
    return { asked: this.asked, poked: this.poked, paused: this.clock() < this.pausedUntil };
  }
}
