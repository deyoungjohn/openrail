import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError, BudgetGovernor } from "./budget.js";
import { IndexerStore } from "./store.js";

const dirs: string[] = [];
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "openrail-budget-"));
  dirs.push(dir);
  return join(dir, "indexer.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryStore() {
  let state: { day: string; used: number } | null = null;
  return {
    budgetState: () => state,
    setBudgetState: (day: string, used: number) => {
      state = { day, used };
    },
  };
}

describe("budget governor", () => {
  it("holds the 7 s spacing under a burst", async () => {
    const sleep = vi.fn(async () => undefined);
    let now = Date.parse("2026-11-04T10:00:00Z");
    const governor = new BudgetGovernor({
      store: memoryStore(),
      sleep,
      now: () => now,
    });
    await governor.beforeCall();
    governor.recordCall();
    await governor.beforeCall();
    expect(sleep).toHaveBeenCalledWith(7000);
    now += 7000;
    await governor.beforeCall();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("stops at the daily budget and resets at UTC midnight", async () => {
    const store = memoryStore();
    let now = Date.parse("2026-11-04T10:00:00Z");
    const governor = new BudgetGovernor({ store, dailyBudget: 2, minSpacingMs: 0, now: () => now });
    await governor.beforeCall();
    governor.recordCall();
    await governor.beforeCall();
    governor.recordCall();
    await expect(governor.beforeCall()).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(governor.health()).toMatchObject({ used: 2, remaining: 0, blocked: true });

    now = Date.parse("2026-11-05T00:00:00Z");
    await expect(governor.beforeCall()).resolves.toBeUndefined();
    expect(governor.health()).toMatchObject({ used: 0, blocked: false });
  });

  it("blocks on 429 until the next UTC day", async () => {
    const store = memoryStore();
    let now = Date.parse("2026-11-04T10:00:00Z");
    const governor = new BudgetGovernor({
      store,
      dailyBudget: 380,
      minSpacingMs: 0,
      now: () => now,
    });
    governor.on429();
    await expect(governor.beforeCall()).rejects.toBeInstanceOf(BudgetExhaustedError);
    now = Date.parse("2026-11-05T00:00:00Z");
    await expect(governor.beforeCall()).resolves.toBeUndefined();
  });

  it("keeps the counter across a store restart", async () => {
    const path = dbPath();
    const first = new IndexerStore(path, "openrail.near");
    const governor = new BudgetGovernor({
      store: first,
      dailyBudget: 5,
      minSpacingMs: 0,
      now: () => Date.parse("2026-11-04T10:00:00Z"),
    });
    await governor.beforeCall();
    governor.recordCall();
    first.close();

    const second = new IndexerStore(path, "openrail.near");
    expect(second.budgetState()).toEqual({ day: "2026-11-04", used: 1 });
    const reopened = new BudgetGovernor({
      store: second,
      dailyBudget: 5,
      minSpacingMs: 0,
      now: () => Date.parse("2026-11-04T10:00:00Z"),
    });
    await reopened.beforeCall();
    reopened.recordCall();
    expect(reopened.health().used).toBe(2);
    second.close();
  });
});
