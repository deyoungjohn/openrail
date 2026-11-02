import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiAppFromEnv } from "./defaults.js";

afterEach(() => {
  delete process.env.NEAR_ROOT_ACCOUNT;
  delete process.env.ISSUER_URL;
  delete process.env.NEAR_RPC_URL;
  vi.restoreAllMocks();
});

describe("production wiring", () => {
  it("exits MISSING_ENV when a required name is absent", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(createApiAppFromEnv()).rejects.toThrow("EXIT:1");
    expect(writes.join("")).toContain("MISSING_ENV: NEAR_ROOT_ACCOUNT");
  });
});
