/**
 * Independent verification test suite for the Payout Worker shield path (Update 59, Rule 5).
 *
 * Requirements:
 * 1. For a held entry with confidential destination: exactly one 1Click shield quote requested.
 * 2. Quote parameters:
 *    - swapType: EXACT_INPUT
 *    - depositType: INTENTS
 *    - recipientType: CONFIDENTIAL_INTENTS
 *    - refundType: INTENTS
 *    - originAsset == destinationAsset == recorded entry asset (never settlement_assets.first() or fixed USDC)
 *    - amount == entry amount
 *    - recipient == entry.owner (and refundTo == claimAccount)
 *    - deadline: ~1 hour ahead (never far future)
 * 3. Sends exactly one vault `forward` / `settle_payout` transfer of that amount to the quote's deposit address.
 * 4. Failed quote leaves entry Held and retries on next tick.
 * 5. Failed transfer leaves entry held / uncertain and retries without duplicate transfer.
 * 6. Idempotency across restart: resumes InFlight entry without duplicate transfer.
 * 7. Below min_amount: nothing sent (skipped).
 * 8. Log leak audit: zero private keys, secrets, or JWT tokens in logs.
 * 9. Non-confidential (e.g. Base address) destinations continue to behave exactly as before.
 */

import { describe, expect, it, vi } from "vitest";
import { OneClickInPayout } from "./oneclick.js";
import type {
  ChainPort,
  HeldEntry,
  PayoutOutcome,
  PayoutRecord,
  QuotePort,
  StatusPort,
} from "./types.js";
import { PayoutWorker } from "./worker.js";

const CUSTOM_DAI = "nep141:dai.omft.near";
const OWNER = "merchant.near";

class TestChain implements ChainPort {
  readonly entries = new Map<string, HeldEntry[]>();
  readonly sent: { tokenId: string; index: number; deposit: string; amount: string }[] = [];
  readonly reports: { tokenId: string; index: number; payoutId: number; outcome: PayoutOutcome }[] =
    [];
  readonly payouts = new Map<number, PayoutRecord>();
  failSend = false;
  private nextId = 1;

  async settleHeld(tokenId: string): Promise<HeldEntry[]> {
    return this.entries.get(tokenId) ?? [];
  }

  async settlementOf(owner: string) {
    const entry = [...this.entries.values()].flat().find((e) => e.owner === owner);
    return entry?.destination ?? null;
  }

  async claimAccount(tokenId: string): Promise<string> {
    return `${tokenId}.openrail.near`;
  }

  async payout(id: number): Promise<PayoutRecord | null> {
    return this.payouts.get(id) ?? null;
  }

  async settlePayout(tokenId: string, index: number, deposit: string, amount: string) {
    if (this.failSend) {
      throw new Error("network transport failure on settlePayout");
    }
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
    return { payoutId, txHash: "mock-tx-hash" };
  }

  async reportPayout(tokenId: string, index: number, payoutId: number, outcome: PayoutOutcome) {
    this.reports.push({ tokenId, index, payoutId, outcome });
    const entry = this.entries.get(tokenId)?.[index];
    if (entry !== undefined) {
      entry.status = { Settled: { payout_id: payoutId, destination_tx: "dest-tx" } };
    }
  }

  async balanceYocto(): Promise<bigint> {
    return 2n * 10n ** 24n;
  }
}

interface TestSetupOptions {
  asset?: string;
  amount?: string;
  minAmount?: string;
  chainType?: string;
  owner?: string;
  destAddress?: string;
  now?: number;
}

function createTestHarness(options: TestSetupOptions = {}) {
  const asset = options.asset ?? CUSTOM_DAI;
  const amount = options.amount ?? "2500000";
  const minAmount = options.minAmount ?? "1000000";
  const chainType = options.chainType ?? "confidential";
  const owner = options.owner ?? OWNER;
  const destAddress = options.destAddress ?? owner;
  const now = options.now ?? Date.parse("2026-11-10T12:00:00.000Z");

  const destination = { chain: chainType, address: destAddress, min_amount: minAmount };

  const chain = new TestChain();
  chain.entries.set("c-1", [
    {
      owner,
      asset,
      amount,
      status: "Held",
      retries: 0,
      destination,
    },
  ]);

  const quoteCalls: any[] = [];
  const quote: QuotePort = {
    quote: vi.fn(async (req) => {
      quoteCalls.push(req);
      return {
        amountIn: req.amount,
        depositAddress: "shield-vault-deposit-addr",
        recipient: req.destination.address,
        deadline: req.deadline,
      };
    }),
  };

  const status: StatusPort = {
    status: vi.fn(async () => ({
      status: "SUCCESS",
      destinationTxHashes: [{ hash: "dest-tx-hash-123" }],
    })),
  };

  const loggedLines: string[] = [];
  const logger = {
    info: (msg: string, ...args: unknown[]) =>
      loggedLines.push(`INFO: ${msg} ${JSON.stringify(args)}`),
    warn: (msg: string, ...args: unknown[]) =>
      loggedLines.push(`WARN: ${msg} ${JSON.stringify(args)}`),
    error: (msg: string, ...args: unknown[]) =>
      loggedLines.push(`ERROR: ${msg} ${JSON.stringify(args)}`),
  };

  const worker = new PayoutWorker({
    discovery: { tokens: async () => ["c-1"] },
    chain,
    quote,
    status,
    logger,
    clock: () => now,
    sleep: async () => undefined,
    settleRecheckMs: 0,
  });

  return { chain, quote, quoteCalls, status, logger, loggedLines, worker, now };
}

describe("Payout Worker Shield Path (Update 59 Independent Gate)", () => {
  it("requests shield quote with exact matching recorded asset (never first settlement asset)", async () => {
    const { worker, quoteCalls, chain } = createTestHarness({ asset: CUSTOM_DAI });
    const summary = await worker.tick();

    expect(summary.sent).toHaveLength(1);
    expect(quoteCalls).toHaveLength(1);
    const req = quoteCalls[0];
    expect(req.asset).toBe(CUSTOM_DAI); // Recorded asset preserved!
    expect(req.destination.chain).toBe("confidential");
    expect(chain.sent[0]?.deposit).toBe("shield-vault-deposit-addr");
    expect(chain.sent[0]?.amount).toBe("2500000");
  });

  it("1Click adapter builds shield quote with EXACT_INPUT, INTENTS, CONFIDENTIAL_INTENTS, and refundType INTENTS", async () => {
    const rawOneClickQuote = vi.fn(async () => ({
      quote: { amountIn: "2500000", amountOut: "2500000", depositAddress: "deposit-shield-1" },
    }));
    const adapter = new OneClickInPayout({ quote: rawOneClickQuote } as never);

    const deadline = new Date(Date.parse("2026-11-10T12:00:00.000Z") + 3600 * 1000).toISOString();
    const result = await adapter.quote({
      asset: CUSTOM_DAI,
      amount: "2500000",
      destination: { chain: "confidential", address: OWNER, min_amount: "1000000" },
      refundTo: "c-1.openrail.near",
      deadline,
    });

    expect(rawOneClickQuote).toHaveBeenCalledTimes(1);
    const params = (
      rawOneClickQuote.mock.calls[0] as unknown as [
        Record<string, unknown> & {
          swapType: string;
          depositType: string;
          recipientType: string;
          refundType: string;
        },
      ]
    )[0];

    // Assert exact required parameters from prompt update 59:
    expect(params.swapType).toBe("EXACT_INPUT");
    expect(params.depositType).toBe("INTENTS");
    expect(params.recipientType).toBe("CONFIDENTIAL_INTENTS");
    expect(params.refundType).toBe("INTENTS");
    expect(params.originAsset).toBe(CUSTOM_DAI);
    expect(params.destinationAsset).toBe(CUSTOM_DAI); // originAsset == destinationAsset == recorded entry asset
    expect(params.amount).toBe("2500000");
    expect(params.recipient).toBe(OWNER);
    expect(params.refundTo).toBe("c-1.openrail.near");
    expect(result.depositAddress).toBe("deposit-shield-1");
  });

  it("sets quote deadline ~1 hour ahead (never far future)", async () => {
    const fixedNow = Date.parse("2026-11-10T12:00:00.000Z");
    const { worker, quoteCalls } = createTestHarness({ now: fixedNow });
    await worker.tick();

    expect(quoteCalls).toHaveLength(1);
    const deadlineMs = Date.parse(quoteCalls[0].deadline);
    const diffSeconds = (deadlineMs - fixedNow) / 1000;
    // Exactly 3600 seconds (1 hour) ahead
    expect(diffSeconds).toBeGreaterThanOrEqual(3500);
    expect(diffSeconds).toBeLessThanOrEqual(3700);
  });

  it("sends exactly one vault transfer to quote deposit address", async () => {
    const { worker, chain } = createTestHarness({ amount: "4000000" });
    const summary = await worker.tick();

    expect(summary.sent).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toEqual({
      tokenId: "c-1",
      index: 0,
      deposit: "shield-vault-deposit-addr",
      amount: "4000000",
    });
  });

  it("refuses to send and reports error if destination address is not the entry owner", async () => {
    const { worker, chain } = createTestHarness({
      owner: "legit-owner.near",
      destAddress: "attacker.near",
    });
    const summary = await worker.tick();

    expect(summary.sent).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
    expect(summary.errors[0]).toContain("confidential destination is not the owner");
  });

  it("leaves entry Held and retries on next tick if quote fails", async () => {
    const { worker, quote, chain } = createTestHarness();
    vi.mocked(quote.quote).mockRejectedValueOnce(new Error("1Click shield service 503"));

    // Tick 1: quote fails
    const first = await worker.tick();
    expect(first.sent).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
    expect(chain.entries.get("c-1")?.[0]?.status).toBe("Held");

    // Tick 2: quote recovers
    const second = await worker.tick();
    expect(second.sent).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);
  });

  it("handles failed transfer cleanly without duplicate send on retry", async () => {
    const { worker, chain } = createTestHarness();
    chain.failSend = true;

    // Tick 1: transfer fails
    const first = await worker.tick();
    expect(first.sent).toHaveLength(0);
    expect(first.errors[0]).toContain("network transport failure");

    // Tick 2: worker must not double-send because entry marked uncertain
    chain.failSend = false;
    const second = await worker.tick();
    expect(second.sent).toHaveLength(0);
    expect(second.skipped[0]).toContain("send state uncertain");
  });

  it("is idempotent across worker restart: resumes InFlight without duplicate transfer", async () => {
    const { worker, chain } = createTestHarness();

    // Tick 1: sends transfer, entry becomes InFlight
    await worker.tick();
    expect(chain.sent).toHaveLength(1);

    // Restart worker with fresh instance
    const restarted = new PayoutWorker({
      discovery: { tokens: async () => ["c-1"] },
      chain,
      quote: { quote: vi.fn(async () => Promise.reject(new Error("Must not quote on restart"))) },
      status: {
        status: async () => ({
          status: "SUCCESS",
          destinationTxHashes: [{ hash: "shielded-dest-tx" }],
        }),
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      sleep: async () => {},
      settleRecheckMs: 0,
    });

    const summary = await restarted.tick();
    // Must NOT send again
    expect(chain.sent).toHaveLength(1);
    expect(summary.settled).toHaveLength(1);
    expect(chain.reports).toHaveLength(1);
    expect(chain.reports[0]?.outcome).toEqual({ Settled: { destination_tx: "shielded-dest-tx" } });
  });

  it("skips held entry if amount is below destination min_amount", async () => {
    const { worker, chain } = createTestHarness({
      amount: "500000",
      minAmount: "1000000",
    });
    const summary = await worker.tick();

    expect(summary.sent).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
    expect(summary.errors[0]).toContain("amount below destination minimum");
  });

  it("preserves non-confidential Base destinations unchanged", async () => {
    const baseAddr = "0x" + "b".repeat(40);
    const { worker, quoteCalls } = createTestHarness({
      chainType: "base",
      destAddress: baseAddr,
    });
    const summary = await worker.tick();

    expect(summary.sent).toHaveLength(1);
    expect(quoteCalls[0]?.destination?.chain).toBe("base");
    expect(quoteCalls[0]?.destination?.address).toBe(baseAddr);
  });

  it("audit: logger never prints private keys, secret seeds, or JWT tokens", async () => {
    const { worker, loggedLines } = createTestHarness();
    await worker.tick();

    const sensitivePatterns = [
      /ed25519:[A-Za-z0-9+/=]{32,}/i,
      /secp256k1:[A-Za-z0-9+/=]{32,}/i,
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
      /bearer\s+[A-Za-z0-9_.-]+/i,
      /private[_-]?key/i,
    ];

    for (const line of loggedLines) {
      for (const pattern of sensitivePatterns) {
        expect(line).not.toMatch(pattern);
      }
    }
  });
});
