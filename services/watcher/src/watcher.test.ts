import { createLogger } from "@openrail/shared";
import { describe, expect, it, vi } from "vitest";
import type { LowBalanceAlert } from "./alerts.js";
import type { WatcherConfig } from "./config.js";
import type { ChainStatus, ClaimView, ConfigView, NearClientLike, Quote } from "./types.js";
import { Watcher } from "./watcher.js";

const ASSETS = ["nep141:a", "nep141:b", "nep141:c", "nep141:d"];
const NOW = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

const CONFIG: WatcherConfig = {
  rootAccount: "openrail.near",
  watcherAccount: "watcher.near",
  fastIntervalMs: 15_000,
  slowIntervalMs: 600_000,
  quoteTtlMs: 72 * HOUR_MS,
  minBalanceNear: 0.5,
  extraClaims: [],
  healthPort: 0,
};

const CONFIG_VIEW: ConfigView = {
  settlement_assets: ASSETS,
  issuers: ["issuer.near"],
  quote_writers: ["api.near"],
  issue_paused: false,
};

const logger = createLogger("watcher-test", () => {});

interface FakeState {
  config: ConfigView;
  claims: ClaimView[];
  quotes: Record<string, Quote[]>;
  balances: Record<string, string[]>;
}

class FakeNear implements NearClientLike {
  readonly calls: Parameters<NearClientLike["sendFunctionCall"]>[0][] = [];
  readonly views: Parameters<NearClientLike["view"]>[0][] = [];
  readonly batches: Parameters<NearClientLike["batchBalanceOf"]>[0][] = [];

  constructor(private readonly state: FakeState) {}

  async view<T>(request: Parameters<NearClientLike["view"]>[0]): Promise<T> {
    this.views.push(request);
    const args = (request.args ?? {}) as Record<string, unknown>;
    switch (request.methodName) {
      case "config":
        return this.state.config as T;
      case "claims_by_issuer":
        return this.state.claims.filter((claim) => claim.issuer_id === String(args.account)) as T;
      case "nft_tokens": {
        const from = Number(args.from_index ?? 0);
        const limit = Number(args.limit ?? 100);
        return this.state.claims
          .slice(from, from + limit)
          .map((claim) => ({ token_id: claim.token_id })) as T;
      }
      case "payment_log":
        return (this.state.quotes[String(args.token_id)] ?? []) as T;
      case "claim":
        return (this.state.claims.find((claim) => claim.token_id === args.token_id) ?? null) as T;
      default:
        throw new Error(`unexpected view ${request.methodName}`);
    }
  }

  async batchBalanceOf(
    request: Parameters<NearClientLike["batchBalanceOf"]>[0],
  ): Promise<string[]> {
    this.batches.push(request);
    return this.state.balances[request.accountId] ?? request.tokenIds.map(() => "0");
  }

  async sendFunctionCall(
    request: Parameters<NearClientLike["sendFunctionCall"]>[0],
  ): Promise<unknown> {
    this.calls.push(request);
    return { ok: true };
  }
}

class FakeChain implements ChainStatus {
  height = 1_000;
  balance = 2n * 10n ** 24n;

  async blockHeight(): Promise<number> {
    return this.height;
  }

  async accountBalanceYocto(): Promise<bigint> {
    return this.balance;
  }
}

function makeClaim(id: string, overrides: Partial<ClaimView> = {}): ClaimView {
  return {
    token_id: id,
    issuer_id: "issuer.near",
    claim_account: `${id}.openrail.near`,
    status: "Issued",
    lock: "None",
    settlement_assets: [...ASSETS],
    last_seen_balance: Object.fromEntries(ASSETS.map((asset) => [asset, "0"])),
    undistributed: [],
    ...overrides,
  };
}

function makeQuote(deadlineRequested: number): Quote {
  return {
    quote_id: `q-${deadlineRequested}`,
    deposit_address: "deposit-address",
    deadline_requested: deadlineRequested,
    refund_to: "refund",
    route_id: "base-usdc",
  };
}

function setup(
  state: FakeState,
  indexer?: { poke(): Promise<void>; registerTx(hash: string): Promise<void> },
): {
  watcher: Watcher;
  near: FakeNear;
  chain: FakeChain;
  alerts: LowBalanceAlert[];
  reports: number;
  advance: (deltaMs: number) => void;
} {
  let now = NOW;
  const near = new FakeNear(state);
  const chain = new FakeChain();
  const alerts: LowBalanceAlert[] = [];
  let reports = 0;
  const watcher = new Watcher({
    near,
    chain,
    config: CONFIG,
    logger,
    alert: async (alert) => {
      alerts.push(alert);
    },
    reportLowBalance: () => {
      reports += 1;
    },
    now: () => now,
    sleep: async () => {},
    ...(indexer === undefined ? {} : { indexer }),
  });
  return {
    watcher,
    near,
    chain,
    alerts,
    get reports() {
      return reports;
    },
    advance: (deltaMs) => {
      now += deltaMs;
    },
  };
}

function openQuote(): Record<string, Quote[]> {
  return { "c-1": [makeQuote(NOW / 1000)] };
}

describe("watcher discovery", () => {
  it("finds a claim issued for a business that is not in config.issuers", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1", { issuer_id: "business.near" })],
      quotes: {},
      balances: { "c-1.openrail.near": ["100", "0", "0", "0"] },
    });
    const summary = await fixture.watcher.tick();
    expect(summary.reconciled).toEqual(["c-1"]);
  });
});

describe("late payments", () => {
  it("books money that arrives on a paid claim (it becomes surplus for the business)", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [
        makeClaim("c-1", {
          status: "Paid",
          last_seen_balance: Object.fromEntries(ASSETS.map((a) => [a, "0"])),
        }),
      ],
      quotes: {},
      balances: { "c-1.openrail.near": ["0", "3000000", "0", "0"] },
    });
    const summary = await fixture.watcher.tick();
    expect(summary.reconciled).toEqual(["c-1"]);
  });

  it("looks at a paid claim only on the slow cadence", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1", { status: "Paid" })],
      quotes: {},
      balances: {},
    });
    await fixture.watcher.tick();
    const batches = fixture.near.batches.length;
    fixture.advance(60_000);
    await fixture.watcher.tick();
    expect(fixture.near.batches.length).toBe(batches);
  });
});

describe("watcher decisions", () => {
  it("a rise triggers exactly one reconcile with 250 Tgas", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1")],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["100", "0", "0", "0"] },
    });

    const summary = await fixture.watcher.tick();

    expect(summary.reconciled).toEqual(["c-1"]);
    expect(fixture.near.calls).toHaveLength(1);
    expect(fixture.near.calls[0]?.methodName).toBe("reconcile");
    expect(fixture.near.calls[0]?.gas).toBe(250_000_000_000_000n);
    expect(fixture.near.calls[0]?.args).toEqual({ token_id: "c-1" });
  });

  it("pokes the indexer after a reconcile", async () => {
    const indexer = {
      poke: vi.fn(async () => undefined),
      registerTx: vi.fn(async () => undefined),
    };
    const fixture = setup(
      {
        config: CONFIG_VIEW,
        claims: [makeClaim("c-1")],
        quotes: openQuote(),
        balances: { "c-1.openrail.near": ["100", "0", "0", "0"] },
      },
      indexer,
    );
    await fixture.watcher.tick();
    expect(indexer.poke).toHaveBeenCalledTimes(1);
  });

  it("no rise sends nothing", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1")],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });

    const summary = await fixture.watcher.tick();

    expect(summary.reconciled).toEqual([]);
    expect(fixture.near.calls).toHaveLength(0);
    expect(fixture.near.batches).toHaveLength(1);
  });

  it("retries distribution when a claim has undistributed legs", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1", { status: "PartiallyPaid", undistributed: [{ Pay: {} }] })],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });

    const summary = await fixture.watcher.tick();

    expect(summary.retried).toEqual(["c-1"]);
    expect(fixture.near.calls.map((call) => call.methodName)).toEqual(["retry_distribution"]);
  });

  it("clears a stale reconciling lock", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1", { lock: { Reconciling: { since: 800 } } })],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });
    fixture.chain.height = 901; // 901 > 800 + 100, so the lock is stale

    const summary = await fixture.watcher.tick();

    expect(summary.cleared).toEqual(["c-1"]);
    expect(fixture.near.calls.map((call) => call.methodName)).toEqual(["clear_stale_lock"]);
  });

  it("does not repeat clear_stale_lock every tick when a module refuses it", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1", { lock: { Reconciling: { since: 800 } } })],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });
    fixture.chain.height = 901;
    await fixture.watcher.tick();
    fixture.advance(15_000);
    await fixture.watcher.tick();
    expect(fixture.near.calls.map((call) => call.methodName)).toEqual(["clear_stale_lock"]);
    fixture.advance(130_000);
    await fixture.watcher.tick();
    expect(fixture.near.calls).toHaveLength(2);
  });

  it("clears an expired transfer window but not a live one", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1", { lock: { TransferWindow: { until: 900 } } })],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });
    fixture.chain.height = 1_000;

    await fixture.watcher.tick();
    expect(fixture.near.calls.map((call) => call.methodName)).toEqual(["clear_stale_lock"]);

    const live = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1", { lock: { TransferWindow: { until: 1_001 } } })],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });
    live.chain.height = 1_000;
    await live.watcher.tick();
    expect(live.near.calls).toHaveLength(0);
  });

  it("drops to a 10-minute cadence after the last quote +72 h", async () => {
    const expiredDeadline = NOW / 1000 - 73 * 60 * 60;
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1")],
      quotes: { "c-1": [makeQuote(expiredDeadline)] },
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });

    const first = await fixture.watcher.tick();
    expect(first.slow).toBe(1);
    expect(fixture.near.batches).toHaveLength(1);

    fixture.advance(15_000);
    const second = await fixture.watcher.tick();
    expect(second.skipped).toBe(1);
    expect(fixture.near.batches).toHaveLength(1);

    fixture.advance(CONFIG.slowIntervalMs);
    const third = await fixture.watcher.tick();
    expect(third.skipped).toBe(0);
    expect(fixture.near.batches).toHaveLength(2);
  });

  it("keeps a hot claim on the 15-second cadence", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1")],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });

    await fixture.watcher.tick();
    fixture.advance(15_000);
    await fixture.watcher.tick();
    expect(fixture.near.batches).toHaveLength(2);
  });

  it("sends nothing for a finished claim whose balance did not rise", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1", { status: "Closed" })],
      quotes: {},
      balances: {},
    });

    await fixture.watcher.tick();
    // Finished claims are still read (slow cadence) so a late payment is booked as surplus.
    expect(fixture.near.calls).toHaveLength(0);
  });
});

describe("watcher health and alerts", () => {
  it("alerts once below 0.5 NEAR, recovers, and alerts again", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1")],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });

    fixture.chain.balance = 400_000_000_000_000_000_000_000n; // 0.4 NEAR
    await fixture.watcher.tick();
    expect(fixture.alerts).toHaveLength(1);
    expect(fixture.reports).toBe(1);
    expect(fixture.watcher.snapshot().status).toBe("degraded");
    expect(fixture.watcher.snapshot().near_balance_near).toBeCloseTo(0.4, 12);

    await fixture.watcher.tick();
    expect(fixture.alerts).toHaveLength(1);

    fixture.chain.balance = 2n * 10n ** 24n;
    await fixture.watcher.tick();
    expect(fixture.watcher.snapshot().status).toBe("ok");

    fixture.chain.balance = 400_000_000_000_000_000_000_000n;
    await fixture.watcher.tick();
    expect(fixture.alerts).toHaveLength(2);
  });

  it("does not alert at exactly the threshold", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [],
      quotes: {},
      balances: {},
    });
    fixture.chain.balance = 5n * 10n ** 23n; // exactly 0.5 NEAR
    await fixture.watcher.tick();
    expect(fixture.alerts).toHaveLength(0);
    expect(fixture.watcher.snapshot().status).toBe("ok");
  });

  it("reports the last block, balance and tracked claims in /health data", async () => {
    const fixture = setup({
      config: CONFIG_VIEW,
      claims: [makeClaim("c-1")],
      quotes: openQuote(),
      balances: { "c-1.openrail.near": ["0", "0", "0", "0"] },
    });
    fixture.chain.height = 2_500;

    await fixture.watcher.tick();
    const snapshot = fixture.watcher.snapshot();
    expect(snapshot.last_block_height).toBe(2_500);
    expect(snapshot.near_balance_yocto).toBe((2n * 10n ** 24n).toString());
    expect(snapshot.near_balance_near).toBe(2);
    expect(snapshot.claims_tracked).toBe(1);
    expect(snapshot.fast_claims).toBe(1);
    expect(snapshot.last_tick_at).not.toBeNull();
  });
});

describe("watcher discovery", () => {
  it("uses extra claim ids for permissionless issuers", async () => {
    const extra = makeClaim("c-9", { issuer_id: "someone-else.near" });
    const fixture = setup({
      config: { ...CONFIG_VIEW, issuers: [] },
      claims: [extra],
      quotes: { "c-9": [makeQuote(NOW / 1000)] },
      balances: { "c-9.openrail.near": ["7", "0", "0", "0"] },
    });
    const watcher = new Watcher({
      near: fixture.near,
      chain: fixture.chain,
      config: { ...CONFIG, extraClaims: ["c-9"] },
      logger,
      alert: async () => {},
      now: () => NOW,
      sleep: async () => {},
    });

    const summary = await watcher.tick();
    expect(summary.reconciled).toEqual(["c-9"]);
    expect(fixture.near.views.some((view) => view.methodName === "claim")).toBe(true);
  });
});
