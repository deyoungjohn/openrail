import { loadRoutes } from "@openrail/shared";
import { describe, expect, it, vi } from "vitest";
import {
  QuoteError,
  QuoteService,
  isQuoteExpired,
  type ClaimSnapshot,
  type QuoteProviderRequest,
} from "./quote.js";

const routes = loadRoutes();
const claim: ClaimSnapshot = {
  tokenId: "c-1",
  claimAccount: "c-1.openrail.near",
  termsHash: "0x" + "a".repeat(64),
  outstanding: "12500000",
  amountDue: "12500000",
  kindRules: {
    ack_required_for_sale: true,
    sellable: true,
    quote_deadline: 3600,
    debtor_optional: false,
  },
};
const clock = () => new Date("2026-11-02T10:00:00Z");

function service(overrides: Partial<ConstructorParameters<typeof QuoteService>[0]> = {}) {
  const log = vi.fn(async () => ({ txHash: "0xlog" }));
  const quote = vi.fn(async (request: QuoteProviderRequest) => ({
    quoteId: "q_1",
    depositAddress: "0xdeposit",
    deadline: "2026-11-03T10:00:00Z",
    amountIn: request.amount,
    amountOut: "12500000",
    spreadBps: 0,
  }));
  const instance = new QuoteService({
    routes,
    claim: async () => claim,
    provider: { quote },
    logger: { logQuote: log },
    clock,
    ids: (prefix) => `${prefix}_1`,
    ...overrides,
  });
  return { instance, log, quote };
}

describe("quote service", () => {
  it("logs the quote before returning a deposit address", async () => {
    const order: string[] = [];
    const { instance } = service({
      provider: {
        quote: async () => {
          order.push("provider");
          return {
            quoteId: "q_1",
            depositAddress: "0xdeposit",
            deadline: "2026-11-03T10:00:00Z",
            amountIn: "12500000",
            amountOut: "12500000",
            spreadBps: 0,
          };
        },
      },
      logger: {
        logQuote: async () => {
          order.push("log_quote");
          return { txHash: "0xlog" };
        },
      },
    });

    const session = await instance.createSession({
      tokenId: "c-1",
      routeId: "R1",
      refundTo: "0x" + "e".repeat(40),
    });
    order.push("returned");

    expect(order).toEqual(["provider", "log_quote", "returned"]);
    expect(session.deposit_address).toBe("0xdeposit");
    expect(session.deadline_requested).toBe(Date.parse("2026-11-02T10:00:00Z") / 1000 + 3600);
  });

  it("refuses when log_quote fails; the address is never returned", async () => {
    const { instance } = service({
      logger: { logQuote: async () => Promise.reject(new Error("chain")) },
    });
    const result = instance
      .createSession({ tokenId: "c-1", routeId: "R1", refundTo: "0x" + "e".repeat(40) })
      .catch((error: unknown) => error);
    await expect(result).resolves.toBeInstanceOf(Error);
    expect((await result) as Error).toHaveProperty("message", "chain");
  });

  it("refuses an unknown route", async () => {
    const { instance } = service();
    await expect(
      instance.createSession({ tokenId: "c-1", routeId: "R99", refundTo: "0x" + "e".repeat(40) }),
    ).rejects.toMatchObject({
      code: "unknown_route",
      status: 400,
    });
  });

  it("uses 30 bps for EXACT_OUTPUT and the origin decimals for FLEX_INPUT", async () => {
    const { instance, quote } = service();
    await instance.createSession({
      tokenId: "c-1",
      routeId: "R9",
      amountUsd: "12.50",
      refundTo: "0x" + "e".repeat(40),
    });
    await instance.createSession({
      tokenId: "c-1",
      routeId: "R1",
      amountUsd: "12.50",
      refundTo: "0x" + "e".repeat(40),
    });
    const [exact, flex] = quote.mock.calls;
    expect(exact?.[0].swapType).toBe("EXACT_OUTPUT");
    expect(exact?.[0].slippageTolerance).toBe(30);
    expect(exact?.[0].amount).toBe("12500000");
    expect(flex?.[0].swapType).toBe("FLEX_INPUT");
    expect(flex?.[0].slippageTolerance).toBe(0);
    expect(flex?.[0].amount).toBe("12500000");
  });

  it("never reuses an expired quote", () => {
    expect(isQuoteExpired("2026-11-02T09:59:59Z", clock())).toBe(true);
    expect(isQuoteExpired("2026-11-02T10:00:01Z", clock())).toBe(false);
  });

  it("carries exact outstanding base units and never floors to cents", async () => {
    const subCent = { ...claim, outstanding: "1234567" };
    const { instance, quote } = service({ claim: async () => subCent });
    const session = await instance.createSession({
      tokenId: "c-1",
      routeId: "R1",
      refundTo: "0x" + "e".repeat(40),
    });
    expect(quote.mock.calls[0]?.[0].amount).toBe("1234567");
    expect(session.amount_in).toBe("1234567");
    expect(session.amount_usd).toBe("1.23");
  });

  it("scales outstanding exactly for an 18-decimal USDC origin", async () => {
    const subCent = { ...claim, outstanding: "1234567" };
    const { instance, quote } = service({ claim: async () => subCent });
    await instance.createSession({
      tokenId: "c-1",
      routeId: "R6",
      refundTo: "0x" + "e".repeat(40),
    });
    expect(quote.mock.calls[0]?.[0].amount).toBe("1234567000000000000");
  });

  it("carries the quote error type", () => {
    expect(new QuoteError(400, "x")).toHaveProperty("code", "x");
  });
});
