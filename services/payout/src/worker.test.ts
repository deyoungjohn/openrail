import { describe, expect, it, vi } from "vitest";
import type {
  ChainPort,
  HeldEntry,
  PayoutOutcome,
  PayoutRecord,
  Quote,
  QuotePort,
  StatusPort,
} from "./types.js";
import { PayoutWorker } from "./worker.js";

const destination = { chain: "base", address: "0x" + "e".repeat(40), min_amount: "1000000" };

class FakeChain implements ChainPort {
  readonly entries = new Map<string, HeldEntry[]>();
  readonly sent: { tokenId: string; index: number; deposit: string; amount: string }[] = [];
  readonly reports: { tokenId: string; index: number; payoutId: number; outcome: PayoutOutcome }[] =
    [];
  readonly payouts = new Map<number, PayoutRecord>();
  failSend = false;
  recheckToInFlight = false;
  private nextId = 1;
  private heldCalls = 0;

  async settleHeld(tokenId: string): Promise<HeldEntry[]> {
    this.heldCalls += 1;
    if (this.recheckToInFlight && this.heldCalls > 1) {
      const entry = this.entries.get(tokenId)?.[0];
      if (entry !== undefined && entry.status === "Held") {
        entry.status = { InFlight: { payout_id: 999 } };
        this.payouts.set(999, {
          id: 999,
          module_id: "settle",
          reference: `${tokenId}#0`,
          source: `${tokenId}.openrail.near`,
          asset: entry.asset,
          amount_in: entry.amount,
          deposit_address: "deposit-from-before-restart",
          status: "Sent",
          created_block: 1,
        });
      }
    }
    return this.entries.get(tokenId) ?? [];
  }
  async settlementOf(): Promise<typeof destination | null> {
    return destination;
  }
  async claimAccount(tokenId: string): Promise<string> {
    return `${tokenId}.openrail.near`;
  }
  async payout(id: number): Promise<PayoutRecord | null> {
    return this.payouts.get(id) ?? null;
  }
  async settlePayout(tokenId: string, index: number, deposit: string, amount: string) {
    const entry = this.entries.get(tokenId)?.[index];
    if (entry === undefined) throw new Error("entry missing");
    const payoutId = this.nextId++;
    entry.status = { InFlight: { payout_id: payoutId } };
    this.payouts.set(payoutId, {
      id: payoutId,
      module_id: "settle",
      reference: `${tokenId}#${index}`,
      source: `${tokenId}.openrail.near`,
      asset: entry.asset,
      amount_in: amount,
      deposit_address: deposit,
      status: "Sent",
      created_block: 1,
    });
    this.sent.push({ tokenId, index, deposit, amount });
    if (this.failSend) throw new Error("network ambiguous");
    return { payoutId, txHash: "tx" };
  }
  async reportPayout(tokenId: string, index: number, payoutId: number, outcome: PayoutOutcome) {
    this.reports.push({ tokenId, index, payoutId, outcome });
    const entry = this.entries.get(tokenId)?.[index];
    if (entry !== undefined)
      entry.status = { Settled: { payout_id: payoutId, destination_tx: "x" } };
  }
  async balanceYocto(): Promise<bigint> {
    return 2n * 10n ** 24n;
  }
}

function held(overrides: Partial<HeldEntry> = {}): HeldEntry {
  return {
    owner: "acme.near",
    asset: "nep141:usdc",
    amount: "2000000",
    status: "Held",
    retries: 0,
    destination,
    ...overrides,
  };
}

function fixture(
  quoteRecipient = destination.address,
  alert?: (message: string, data?: Record<string, unknown>) => void,
) {
  const chain = new FakeChain();
  chain.entries.set("c-1", [held()]);
  const quote: QuotePort = {
    quote: vi.fn(async (): Promise<Quote> => ({
      amountIn: "2000000",
      depositAddress: "deposit",
      recipient: quoteRecipient,
      deadline: "2026-11-06T00:00:00Z",
    })),
  };
  const status: StatusPort = {
    status: vi.fn(async () => ({
      status: "SUCCESS",
      destinationTxHashes: [{ hash: "dest-tx" }],
    })),
  };
  const worker = new PayoutWorker({
    discovery: { tokens: async () => ["c-1"] },
    chain,
    quote,
    status,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    clock: () => Date.parse("2026-11-05T00:00:00Z"),
    sleep: async () => undefined,
    settleRecheckMs: 0,
    ...(alert === undefined ? {} : { alert }),
  });
  return { chain, quote, status, worker };
}

describe("settle payout worker", () => {
  it("settle_quote_recipient_checked_before_send", async () => {
    const { chain, worker } = fixture("0x" + "f".repeat(40));
    const summary = await worker.tick();
    expect(chain.sent).toHaveLength(0);
    expect(summary.errors[0]).toContain("recipient mismatch");
  });

  it("sends then reports success on the next tick", async () => {
    const { chain, worker } = fixture();
    const first = await worker.tick();
    expect(first.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({ deposit: "deposit", amount: "2000000" });

    const second = await worker.tick();
    expect(second.settled).toHaveLength(1);
    expect(chain.reports[0]?.outcome).toEqual({ Settled: { destination_tx: "dest-tx" } });
  });

  it("resumes an in-flight payout after a restart without sending again", async () => {
    const { chain, worker } = fixture();
    await worker.tick();
    const restarted = new PayoutWorker({
      discovery: { tokens: async () => ["c-1"] },
      chain,
      quote: { quote: async () => Promise.reject(new Error("must not quote")) },
      status: {
        status: async () => ({ status: "SUCCESS", destinationTxHashes: [{ hash: "dest-tx" }] }),
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      sleep: async () => undefined,
      settleRecheckMs: 0,
    });
    const summary = await restarted.tick();
    expect(chain.sent).toHaveLength(1);
    expect(summary.settled).toHaveLength(1);
  });

  it("keeps INCOMPLETE_DEPOSIT pending instead of reporting a refund", async () => {
    const { chain, worker, status } = fixture();
    await worker.tick();
    vi.mocked(status.status).mockResolvedValueOnce({
      status: "INCOMPLETE_DEPOSIT",
      destinationTxHashes: [],
    });
    const summary = await worker.tick();
    expect(chain.reports).toHaveLength(0);
    expect(summary.refunded).toHaveLength(0);
    expect(summary.skipped.some((entry) => entry.includes("INCOMPLETE_DEPOSIT"))).toBe(true);
  });

  it("does not guess a refund amount and alerts", async () => {
    const alert = vi.fn();
    const { chain, worker, status } = fixture(undefined, alert);
    await worker.tick();
    vi.mocked(status.status).mockResolvedValueOnce({
      status: "REFUNDED",
      destinationTxHashes: [],
    });
    const summary = await worker.tick();
    expect(chain.reports).toHaveLength(0);
    expect(summary.errors.some((entry) => entry.includes("refund amount missing"))).toBe(true);
    expect(alert).toHaveBeenCalledWith(
      expect.stringContaining("refund amount missing"),
      expect.any(Object),
    );
  });

  it("re-reads settle_held before sending and skips an entry that became InFlight", async () => {
    const { chain, worker } = fixture();
    chain.recheckToInFlight = true;
    const summary = await worker.tick();
    expect(chain.sent).toHaveLength(0);
    expect(summary.skipped.some((entry) => entry.includes("became InFlight"))).toBe(true);
  });

  it("reports a refund", async () => {
    const { chain, worker, status } = fixture();
    await worker.tick();
    vi.mocked(status.status).mockResolvedValueOnce({
      status: "REFUNDED",
      destinationTxHashes: [],
      refundedAmount: "2000000",
    });
    const summary = await worker.tick();
    expect(summary.refunded).toHaveLength(1);
    expect(chain.reports[0]?.outcome).toEqual({ Refunded: { amount: "2000000" } });
  });

  it("does not resend when a send may have gone out but the call errored", async () => {
    const { chain, worker } = fixture();
    chain.failSend = true;
    await worker.tick();
    expect(chain.sent).toHaveLength(1);
    await worker.tick();
    expect(chain.sent).toHaveLength(1);
    expect(chain.reports).toHaveLength(1);
  });

  it("skips a held entry without a destination", async () => {
    const { chain, worker } = fixture();
    chain.settlementOf = async () => null;
    const summary = await worker.tick();
    expect(chain.sent).toHaveLength(0);
    expect(summary.skipped[0]).toContain("no destination");
  });
});
