import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiAppFromEnv, storageCreditOf } from "./defaults.js";

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

describe("storage credit", () => {
  it("is read from the contract for the signed-in account, not from the environment", async () => {
    process.env.STORAGE_CREDIT_BALANCE = "0";
    const view = vi.fn().mockResolvedValue("100000000000000000000000");
    const credit = await storageCreditOf({ view }, "openrail.near", "acme.near");
    expect(view).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: "openrail.near",
        methodName: "storage_credit_of",
        args: { account_id: "acme.near" },
      }),
    );
    expect(credit.balance).toBe("100000000000000000000000");
    delete process.env.STORAGE_CREDIT_BALANCE;
  });
  it("refuses a value that is not a yoctoNEAR integer", async () => {
    const view = vi.fn().mockResolvedValue({ weird: true });
    await expect(storageCreditOf({ view }, "openrail.near", "acme.near")).rejects.toThrow();
  });
});
