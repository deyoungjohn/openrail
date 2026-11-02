import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGuard } from "./index.js";

const ENV_KEYS = ["DRY_RUN", "OWED_CONFIRM_MAINNET", "MAX_SPEND_USD"] as const;

beforeEach(() => {
  delete process.env.DRY_RUN;
  delete process.env.OWED_CONFIRM_MAINNET;
  delete process.env.MAX_SPEND_USD;
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

describe("spend guard", () => {
  it("defaults to a dry run and never executes a value move", async () => {
    const execute = vi.fn(async () => "moved");
    const guard = new SpendGuard();

    const result = await guard.run({ usd: 1, confirmation: "YES", execute });

    expect(result.status).toBe("DRY_RUN");
    expect(result.value).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(guard.totalUsd()).toBe(1);
  });

  it("refuses a wrong typed confirmation even with the mainnet flag", async () => {
    process.env.DRY_RUN = "no";
    process.env.OWED_CONFIRM_MAINNET = "yes";
    process.env.MAX_SPEND_USD = "5";
    const execute = vi.fn(async () => "moved");
    const guard = new SpendGuard();

    await expect(guard.run({ usd: 1, confirmation: "yes", execute })).rejects.toThrow(
      "MAINNET_CONFIRMATION_REQUIRED",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(guard.totalUsd()).toBe(0);
  });

  it("refuses a live move without OWED_CONFIRM_MAINNET=yes", async () => {
    process.env.DRY_RUN = "no";
    process.env.MAX_SPEND_USD = "5";
    const guard = new SpendGuard();

    await expect(guard.run({ usd: 1, confirmation: "YES" })).rejects.toThrow(
      "MAINNET_NOT_CONFIRMED",
    );
  });

  it("executes only when the flag, typed confirmation and cap all allow it", async () => {
    process.env.DRY_RUN = "no";
    process.env.OWED_CONFIRM_MAINNET = "yes";
    process.env.MAX_SPEND_USD = "5";
    const execute = vi.fn(async () => "moved");
    const guard = new SpendGuard();

    const result = await guard.run({ usd: 2, confirmation: "YES", execute });

    expect(result.status).toBe("SENT");
    expect(result.value).toBe("moved");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("allows exactly the cap and refuses one cent over without moving the total", () => {
    process.env.MAX_SPEND_USD = "5";
    const guard = new SpendGuard();

    expect(guard.plan(5)).toBe(5);
    expect(() => guard.plan(0.01)).toThrow("SPEND_CAP_EXCEEDED");
    expect(guard.totalUsd()).toBe(5);
  });

  it("refuses a running total over the cap across several plans", () => {
    process.env.MAX_SPEND_USD = "5";
    const guard = new SpendGuard();

    guard.plan(3);
    expect(() => guard.plan(2.5)).toThrow("SPEND_CAP_EXCEEDED");
    expect(guard.totalUsd()).toBe(3);
  });

  it("rejects an invalid amount", () => {
    const guard = new SpendGuard();
    expect(() => guard.plan(-1)).toThrow("SPEND_INVALID_AMOUNT");
    expect(() => guard.plan(Number.NaN)).toThrow("SPEND_INVALID_AMOUNT");
  });
});
