import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendGuard, promptYes } from "./index.js";

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

  it("fails closed when live and MAX_SPEND_USD is unset", () => {
    process.env.DRY_RUN = "no";
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    const guard = new SpendGuard();

    expect(() => guard.plan(1)).toThrow("EXIT:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(writes.join("")).toContain("MISSING_ENV: MAX_SPEND_USD");
  });

  it("keeps the default cap for a dry run when MAX_SPEND_USD is unset", () => {
    const guard = new SpendGuard();
    expect(guard.plan(5)).toBe(5);
    expect(() => guard.plan(0.01)).toThrow("SPEND_CAP_EXCEEDED");
  });

  it("rejects an invalid amount", () => {
    const guard = new SpendGuard();
    expect(() => guard.plan(-1)).toThrow("SPEND_INVALID_AMOUNT");
    expect(() => guard.plan(Number.NaN)).toThrow("SPEND_INVALID_AMOUNT");
  });
});

describe("typed confirmation prompt", () => {
  it("refuses when the streams are not a TTY", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    await expect(promptYes("Type YES", { input, output })).rejects.toThrow("PROMPT_NOT_A_TTY");
    input.destroy();
    output.destroy();
  });

  it("returns the typed answer from a TTY stream", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    const output = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    output.isTTY = true;

    const answer = promptYes("Type YES to continue", { input, output });
    input.write("YES\n");

    await expect(answer).resolves.toBe("YES");
    input.destroy();
    output.destroy();
  });
});
