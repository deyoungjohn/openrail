import { describe, expect, it, vi } from "vitest";
import { cachedHealth } from "./health-cache.js";

describe("cachedHealth: /health must not spend RPC quota on every poll", () => {
  it("answers repeated polls within the window from one underlying check", async () => {
    let now = 1_000;
    const check = vi.fn(async () => ({ ok: 1 }));
    const health = cachedHealth(check, { okMs: 60_000, failMs: 15_000, now: () => now });
    expect(await health()).toEqual({ ok: 1 });
    now += 59_000;
    expect(await health()).toEqual({ ok: 1 });
    expect(check).toHaveBeenCalledTimes(1);
    now += 2_000;
    await health();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("remembers a failure for a short time, so a rate-limited RPC is not hammered, then tries again", async () => {
    let now = 0;
    const check = vi
      .fn<() => Promise<{ ok: number }>>()
      .mockRejectedValueOnce(new Error("RPC_HTTP_429"))
      .mockResolvedValue({ ok: 2 });
    const health = cachedHealth(check, { okMs: 60_000, failMs: 15_000, now: () => now });
    await expect(health()).rejects.toThrow("RPC_HTTP_429");
    now += 5_000;
    await expect(health()).rejects.toThrow("RPC_HTTP_429");
    expect(check).toHaveBeenCalledTimes(1);
    now += 11_000;
    expect(await health()).toEqual({ ok: 2 });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("runs one check at a time when polls arrive together", async () => {
    const now = 0;
    let release: (v: { ok: number }) => void = () => {};
    const check = vi.fn(
      () =>
        new Promise<{ ok: number }>((resolve) => {
          release = resolve;
        }),
    );
    const health = cachedHealth(check, { okMs: 60_000, failMs: 15_000, now: () => now });
    const a = health();
    const b = health();
    release({ ok: 3 });
    expect(await a).toEqual({ ok: 3 });
    expect(await b).toEqual({ ok: 3 });
    expect(check).toHaveBeenCalledTimes(1);
  });
});
