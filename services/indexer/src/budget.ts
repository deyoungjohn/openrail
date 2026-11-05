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
  dailyBudget?: number;
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
  private readonly dailyBudget: number;
  private readonly minSpacingMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private lastCall = 0;
  private loggedDay: string | null = null;

  constructor(options: BudgetGovernorOptions) {
    this.store = options.store;
    this.dailyBudget = Math.max(0, options.dailyBudget ?? 380);
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

  /** A 429 stops calls until the next UTC day. */
  on429(): void {
    const state = this.state();
    this.store.setBudgetState(state.day, this.dailyBudget);
    if (this.loggedDay !== state.day) {
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
