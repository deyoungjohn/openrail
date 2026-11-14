/** Small daily budget/spacing guard for the worker's RPC and explorer calls. */
export class CallBudget {
  private day = "";
  private used = 0;
  private last = 0;

  constructor(
    private readonly dailyBudget = 380,
    private readonly minSpacingMs = 7_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private roll(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
  }

  async beforeCall(): Promise<void> {
    this.roll();
    if (this.used >= this.dailyBudget) throw new Error("PAYOUT_CALL_BUDGET_EXHAUSTED");
    const elapsed = this.now() - this.last;
    if (elapsed < this.minSpacingMs) await this.sleep(this.minSpacingMs - elapsed);
  }

  recordCall(): void {
    this.roll();
    this.used = Math.min(this.dailyBudget, this.used + 1);
    this.last = this.now();
  }

  health(): { day: string; used: number; daily_budget: number; remaining: number } {
    this.roll();
    return {
      day: this.day,
      used: this.used,
      daily_budget: this.dailyBudget,
      remaining: Math.max(0, this.dailyBudget - this.used),
    };
  }
}
