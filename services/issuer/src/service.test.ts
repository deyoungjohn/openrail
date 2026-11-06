import type { FunctionCallRequest, ViewRequest } from "@openrail/shared";
import { createLogger } from "@openrail/shared";
import { describe, expect, it, vi } from "vitest";
import {
  IssuerService,
  REQUIRED_ISSUE_DEPOSIT_YOCTO,
  type IssuerServiceConfig,
} from "./service.js";
import type {
  AccountChecker,
  AckEvmRequest,
  IssueForRequest,
  LogQuoteRequest,
  NearClientLike,
  StorageCreditReader,
} from "./types.js";

const ROOT = "openrail.near";
const logger = createLogger("issuer-test", () => {});

function ok(returnValue?: unknown): unknown {
  const encoded =
    returnValue === undefined ? "" : Buffer.from(JSON.stringify(returnValue)).toString("base64");
  return { transaction: { hash: "tx-1" }, status: { SuccessValue: encoded } };
}

function failed(): unknown {
  return { transaction: { hash: "tx-fail" }, status: { Failure: { ActionError: {} } } };
}

class FakeNear implements NearClientLike {
  readonly calls: FunctionCallRequest[] = [];
  readonly views: ViewRequest[] = [];
  constructor(
    private readonly result: (method: string) => unknown = () => ok(),
    private readonly claim: unknown = null,
  ) {}

  async sendFunctionCall(request: FunctionCallRequest): Promise<unknown> {
    this.calls.push(request);
    return this.result(request.methodName);
  }

  async view<T>(request: ViewRequest): Promise<T> {
    this.views.push(request);
    if (request.methodName === "claim") return this.claim as T;
    throw new Error(`unexpected view ${request.methodName}`);
  }
}

class FakeCredit implements StorageCreditReader {
  credit = 2n * 10n ** 22n;
  async storageCreditOf(): Promise<bigint> {
    return this.credit;
  }
}

class FakeAccounts implements AccountChecker {
  readonly calls: string[] = [];
  constructor(private readonly sequence: boolean[]) {}

  async exists(accountId: string): Promise<boolean> {
    this.calls.push(accountId);
    return this.sequence.shift() ?? false;
  }
}

interface Fixture {
  service: IssuerService;
  issuer: FakeNear;
  relay: FakeNear;
  credit: FakeCredit;
  accounts: FakeAccounts;
  config: IssuerServiceConfig;
}

function fixture(
  options: {
    issuerResult?: (method: string) => unknown;
    accounts?: boolean[];
    claim?: unknown;
    indexer?: { poke(): Promise<void>; registerTx(hash: string): Promise<void> };
    sponsor?: {
      sponsorStatusOf(business: string): Promise<{ pool: bigint; cap: number; used: number }>;
    };
  } = {},
): Fixture {
  const config: IssuerServiceConfig = {
    rootAccount: ROOT,
    requiredDepositYocto: REQUIRED_ISSUE_DEPOSIT_YOCTO,
    accountWaitMs: 3,
    accountPollMs: 1,
    now: () => 1_800_000_000_000,
    sleep: async () => {},
  };
  const issuer = new FakeNear(options.issuerResult, options.claim);
  const relay = new FakeNear();
  const credit = new FakeCredit();
  const accounts = new FakeAccounts(options.accounts ?? [true]);
  const service = new IssuerService({
    issuerNear: issuer,
    relayNear: relay,
    credit,
    accounts,
    config,
    logger,
    ...(options.indexer === undefined ? {} : { indexer: options.indexer }),
    ...(options.sponsor === undefined ? {} : { sponsor: options.sponsor }),
  });
  return { service, issuer, relay, credit, accounts, config };
}

const ISSUE: IssueForRequest = {
  business: "acme.near",
  kind: 0,
  debtor: { Near: "client.near" },
  termsHash: "0x" + "11".repeat(32),
  amountDue: "1000000",
  dueDate: 1_800_000_000,
};

const QUOTE: LogQuoteRequest = {
  tokenId: "c-5",
  quoteId: "q-1",
  depositAddress: "deposit-address",
  deadlineRequested: 1_800_000_000,
  refundTo: "0x" + "22".repeat(20),
  routeId: "base-usdc",
};

const ACK: AckEvmRequest = {
  tokenId: "c-5",
  chainId: 8453,
  signature: "0x" + "33".repeat(65),
};

describe("issuer prepareIssue", () => {
  it("reports the storage credit and the top-up account/amount", async () => {
    const { service } = fixture();
    await expect(service.prepareIssue("acme.near")).resolves.toEqual({
      account: ROOT,
      amount: REQUIRED_ISSUE_DEPOSIT_YOCTO.toString(),
      storageCredit: (2n * 10n ** 22n).toString(),
    });
  });

  it("reports sponsored when the business credit is low and the pool/cap allow it", async () => {
    const { service, credit } = fixture({
      sponsor: { sponsorStatusOf: async () => ({ pool: 10n ** 23n, cap: 5, used: 1 }) },
    });
    credit.storageCreditOf = async () => 0n;
    await expect(service.prepareIssue("acme.near")).resolves.toMatchObject({
      sponsored: true,
      sponsorCap: 5,
      sponsorUsed: 1,
      sponsoredRemaining: 4,
    });
  });

  it("does not report sponsored when the business has enough own credit", async () => {
    const { service } = fixture({
      sponsor: { sponsorStatusOf: async () => ({ pool: 10n ** 23n, cap: 5, used: 1 }) },
    });
    await expect(service.prepareIssue("acme.near")).resolves.toMatchObject({ sponsored: false });
  });

  it("treats a missing sponsor_status view as no sponsorship", async () => {
    const { service, credit } = fixture({
      sponsor: {
        sponsorStatusOf: async () => {
          throw new Error("Method sponsor_status is not found");
        },
      },
    });
    credit.storageCreditOf = async () => 0n;
    await expect(service.prepareIssue("acme.near")).resolves.toMatchObject({
      storageCredit: "0",
      sponsored: false,
    });
  });

  it("surfaces an unavailable storage_credit_of view", async () => {
    const { service, credit } = fixture();
    credit.storageCreditOf = async () => {
      throw new Error("Method storage_credit_of is not found");
    };
    await expect(service.prepareIssue("acme.near")).rejects.toThrow("storage_credit_of");
  });
});

describe("issuer issueFor", () => {
  it("takes the token id from the receipt, derives the claim account and maps the args", async () => {
    const { service, issuer } = fixture({ issuerResult: () => ok("c-5") });

    const result = await service.issueFor(ISSUE);

    expect(result).toEqual({
      txHash: "tx-1",
      tokenId: "c-5",
      claimAccount: "c-5.openrail.near",
    });
    expect(issuer.calls).toHaveLength(1);
    expect(issuer.calls[0]?.methodName).toBe("issue_for");
    expect(issuer.calls[0]?.gas).toBe(60_000_000_000_000n);
    expect(issuer.calls[0]?.args).toEqual({
      business: "acme.near",
      kind: 0,
      debtor: { Near: "client.near" },
      terms_hash: ISSUE.termsHash,
      amount_due: "1000000",
      due_date: 1_800_000_000,
      metadata: null,
    });
  });

  it("waits for the claim account to exist", async () => {
    const { service, accounts } = fixture({
      issuerResult: () => ok("c-5"),
      accounts: [false, false, true],
    });
    await service.issueFor(ISSUE);
    expect(accounts.calls).toEqual(["c-5.openrail.near", "c-5.openrail.near", "c-5.openrail.near"]);
  });

  it("registers the issue transaction and pokes the indexer", async () => {
    const indexer = {
      poke: vi.fn(async () => undefined),
      registerTx: vi.fn(async () => undefined),
    };
    const { service } = fixture({ issuerResult: () => ok("c-5"), indexer });
    await service.issueFor(ISSUE);
    expect(indexer.registerTx).toHaveBeenCalledWith("tx-1");
    expect(indexer.poke).toHaveBeenCalledTimes(1);
  });

  it("fails when the claim account never appears", async () => {
    const { service } = fixture({
      issuerResult: () => ok("c-5"),
      accounts: [false, false, false],
    });
    await expect(service.issueFor(ISSUE)).rejects.toMatchObject({
      status: 504,
      code: "CLAIM_ACCOUNT_NOT_READY",
    });
  });

  it("surfaces a failed transaction", async () => {
    const { service } = fixture({ issuerResult: () => failed() });
    await expect(service.issueFor(ISSUE)).rejects.toMatchObject({
      status: 502,
      code: "NEAR_CALL_FAILED",
    });
  });

  it("rejects a non-token-id return value", async () => {
    const { service } = fixture({ issuerResult: () => ok(42) });
    await expect(service.issueFor(ISSUE)).rejects.toMatchObject({
      status: 502,
      code: "NEAR_RETURN_INVALID",
    });
  });
});

describe("issuer logQuote and acknowledgeEvm", () => {
  it("maps logQuote to the contract Quote shape", async () => {
    const { service, issuer } = fixture();
    const result = await service.logQuote(QUOTE);
    expect(result).toEqual({ txHash: "tx-1" });
    expect(issuer.calls[0]?.methodName).toBe("log_quote");
    expect(issuer.calls[0]?.gas).toBe(10_000_000_000_000n);
    expect(issuer.calls[0]?.args).toEqual({
      token_id: "c-5",
      quote: {
        quote_id: "q-1",
        deposit_address: "deposit-address",
        deadline_requested: 1_800_000_000,
        refund_to: "0x" + "22".repeat(20),
        route_id: "base-usdc",
      },
    });
  });

  it("uses the relay key for acknowledge_evm and returns the ack", async () => {
    const ack = { scheme: { Evm: { chain_id: 8453, signer: "0x" + "ee".repeat(20) } }, block: 7 };
    const { service, issuer, relay } = fixture({ claim: { ack } });
    const result = await service.acknowledgeEvm(ACK);
    expect(result).toEqual({ txHash: "tx-1", ack });
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]?.methodName).toBe("acknowledge_evm");
    expect(relay.calls[0]?.gas).toBe(10_000_000_000_000n);
    expect(relay.calls[0]?.args).toEqual({
      token_id: "c-5",
      chain_id: 8453,
      sig: ACK.signature,
    });
    expect(issuer.calls).toHaveLength(0);
  });

  it("returns a typed error for a failed ack", async () => {
    const failing = new IssuerService({
      issuerNear: new FakeNear(),
      relayNear: new FakeNear(() => failed()),
      credit: new FakeCredit(),
      accounts: new FakeAccounts([true]),
      config: {
        rootAccount: ROOT,
        requiredDepositYocto: REQUIRED_ISSUE_DEPOSIT_YOCTO,
        accountWaitMs: 1,
        accountPollMs: 1,
        now: () => 0,
        sleep: async () => {},
      },
      logger,
    });
    await expect(failing.acknowledgeEvm(ACK)).rejects.toMatchObject({
      status: 502,
      code: "NEAR_CALL_FAILED",
    });
  });
});

describe("issuer predicts the next claim id (the terms hash binds the claim account)", () => {
  const withCounter = (last: number, issuerResult: () => unknown = () => ok("c-5")) => {
    const base = fixture({ issuerResult });
    const service = new IssuerService({
      issuerNear: base.issuer,
      relayNear: new FakeNear(),
      credit: base.credit,
      tokens: { nextTokenId: async () => last },
      accounts: base.accounts,
      config: base.config,
      logger,
    });
    return { service };
  };

  it("reports the id after the newest claim, with its claim account", async () => {
    const { service } = withCounter(5);
    const prepared = await service.prepareIssue("acme.near");
    expect(prepared.tokenId).toBe("c-5");
    expect(prepared.claimAccount).toBe("c-5.openrail.near");
    expect(prepared.storageCredit).toBe((2n * 10n ** 22n).toString());
  });

  it("starts at c-1 on an empty contract", async () => {
    const { service } = withCounter(1);
    expect((await service.prepareIssue("acme.near")).tokenId).toBe("c-1");
  });

  it("accepts the mint when the id is the one predicted", async () => {
    const { service } = withCounter(5);
    const result = await service.issueFor({ ...ISSUE, expectedTokenId: "c-5" });
    expect(result.tokenId).toBe("c-5");
  });

  it("refuses a mint that took another id, and the next prediction moves past it", async () => {
    const { service } = withCounter(5, () => ok("c-9"));
    await expect(service.issueFor({ ...ISSUE, expectedTokenId: "c-5" })).rejects.toMatchObject({
      status: 409,
      code: "TOKEN_ID_MISMATCH",
    });
    expect((await service.prepareIssue("acme.near")).tokenId).toBe("c-10");
  });

  it("without a counter, prepare reports no id (old behaviour)", async () => {
    const { service } = fixture();
    const prepared = await service.prepareIssue("acme.near");
    expect(prepared.tokenId).toBeUndefined();
  });
});
