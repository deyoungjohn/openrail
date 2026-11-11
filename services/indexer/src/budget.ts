/** NearBlocks call budget: 10/min spacing and a persistent daily counter. */
export class BudgetExhaustedError extends Error {
  override readonly name = "BudgetExhaustedError";
  readonly code = "NEARBLOCKS_BUDGET_EXHAUSTED";

  constructor(message = "NearBlocks daily budget exhausted") {
    super(message);
  }
}

export interface BudgetStateStore {
  budgetState(): { day: string; used: number } | null;
  setBudgetState(day: string, used: number): void;
}

export interface BudgetGovernorOptions {
  store: BudgetStateStore;
  /** Calls a day for ONE key. */
  dailyBudget?: number;
  /** How many keys share the work: the budget of the day is dailyBudget times this. */
  keyCount?: number;
  minSpacingMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface BudgetHealth {
  day: string;
  used: number;
  daily_budget: number;
  remaining: number;
  blocked: boolean;
  next_reset: string;
}

export function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nextUtcMidnight(timestamp: number): string {
  const next = new Date(timestamp);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

export class BudgetGovernor {
  private readonly store: BudgetStateStore;
  private readonly perKey: number;
  private readonly keyCount: number;
  private readonly dailyBudget: number;
  private readonly minSpacingMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private lastCall = 0;
  private loggedDay: string | null = null;

  constructor(options: BudgetGovernorOptions) {
    this.store = options.store;
    this.perKey = Math.max(0, options.dailyBudget ?? 380);
    this.keyCount = Math.max(1, Math.floor(options.keyCount ?? 1));
    this.dailyBudget = this.perKey * this.keyCount;
    this.minSpacingMs = Math.max(0, options.minSpacingMs ?? 7_000);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => undefined);
  }

  private state(): { day: string; used: number } {
    const now = this.now();
    const day = utcDay(now);
    const stored = this.store.budgetState();
    if (stored === null || stored.day !== day) {
      this.store.setBudgetState(day, 0);
      return { day, used: 0 };
    }
    return stored;
  }

  /** Wait for the 7 s spacing and throw when the day's budget is spent. */
  async beforeCall(): Promise<void> {
    const state = this.state();
    if (state.used >= this.dailyBudget) {
      if (this.loggedDay !== state.day) {
        this.loggedDay = state.day;
        this.log(`NearBlocks budget exhausted for ${state.day}`);
      }
      throw new BudgetExhaustedError();
    }
    const elapsed = this.now() - this.lastCall;
    if (elapsed < this.minSpacingMs) await this.sleep(this.minSpacingMs - elapsed);
  }

  /** The key to use for the next call: each key takes its own share of the day, in order. */
  keyIndex(): number {
    if (this.perKey === 0) return 0;
    return Math.min(this.keyCount - 1, Math.floor(this.state().used / this.perKey));
  }

  /** Count one NearBlocks attempt. */
  recordCall(): void {
    const state = this.state();
    const used = Math.min(this.dailyBudget, state.used + 1);
    this.store.setBudgetState(state.day, used);
    this.lastCall = this.now();
    if (used >= this.dailyBudget && this.loggedDay !== state.day) {
      this.loggedDay = state.day;
      this.log(`NearBlocks budget exhausted for ${state.day}`);
    }
  }

  /** A 429 spends the day of the key that got it: the next key takes over, and with none left calls stop until the next UTC day. */
  on429(): void {
    const state = this.state();
    const index = this.keyIndex();
    this.store.setBudgetState(state.day, Math.min(this.dailyBudget, (index + 1) * this.perKey));
    if (index + 1 < this.keyCount) {
      this.log(`NearBlocks key ${index + 1} returned 429; using key ${index + 2}`);
    } else if (this.loggedDay !== state.day) {
      this.loggedDay = state.day;
      this.log(`NearBlocks returned 429; blocked until ${nextUtcMidnight(this.now())}`);
    }
  }

  health(): BudgetHealth {
    const state = this.state();
    return {
      day: state.day,
      used: state.used,
      daily_budget: this.dailyBudget,
      remaining: Math.max(0, this.dailyBudget - state.used),
      blocked: state.used >= this.dailyBudget,
      next_reset: nextUtcMidnight(this.now()),
    };
  }
}
