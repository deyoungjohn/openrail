import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiAppFromEnv, createCashoutPort, storageCreditOf } from "./defaults.js";

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

// Incident 9 Nov: a cash-out quoted as EXACT_OUTPUT was signed for the amount to receive, not the amount to pay in,
// so 1Click saw a deposit short by its fees and held the order. A cash-out is now EXACT_INPUT: the amount the
// merchant enters is exactly what leaves the balance, and the fees come out of it.
describe("cash-out quote", () => {
  const fake = () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      quote: vi.fn(async (r: Record<string, unknown>) => {
        requests.push(r);
        return {
          quote: {
            amountIn: r.amount,
            amountOut: "10957600",
            depositAddress: "f6689c55deaa3041b2300f70d068ab08707b79291ffd7a84afa79d3d9393f337",
            deadline: "2026-11-12T04:29:26.361Z",
          },
        };
      }),
    };
    return { requests, client };
  };

  it("asks for an exact input: what the merchant enters is what is deposited", async () => {
    const { requests, client } = fake();
    const port = createCashoutPort(client as never);
    const quote = await port.quote({
      amount: "10960000",
      destinationChain: "base",
      address: "0x12dcbbc7f96b87220e90b46d9528db156b1da841",
      refundTo: "iamyoungjohn.near",
      sourceAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    });
    expect(requests[0]?.swapType).toBe("EXACT_INPUT");
    expect(requests[0]?.amount).toBe("10960000");
    expect(requests[0]?.originAsset).toBe(
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    );
    // The amount to sign is the amount quoted, and the deposit never falls short of what 1Click needs.
    expect(quote.amount).toBe("10960000");
    expect(quote.min_amount_in).toBe("10960000");
    expect(quote.swap_type).toBe("EXACT_INPUT");
    // What arrives is what 1Click says; the cost is the difference, rounded up to the cent.
    expect(quote.amount_out).toBe("10957600");
    expect(quote.route_cost_usd).toBe("0.01");
  });
});
