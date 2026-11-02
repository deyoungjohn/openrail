import type { FunctionCallRequest, ViewRequest } from "@openrail/shared";
import { createLogger } from "@openrail/shared";
import { describe, expect, it } from "vitest";
import { IssuerError } from "./errors.js";
import {
  IssuerService,
  REQUIRED_ISSUE_DEPOSIT_YOCTO,
  type IssuerServiceConfig,
} from "./service.js";
import type {
  AccountChecker,
  AckEvmRequest,
  IssueForRequest,
  IssuerStateReader,
  LogQuoteRequest,
  NearClientLike,
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

class FakeState implements IssuerStateReader {
  next = 5;
  credit = 2n * 10n ** 22n;

  async nextTokenId(): Promise<number> {
    return this.next;
  }

  async storageCredit(): Promise<bigint> {
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
  state: FakeState;
  accounts: FakeAccounts;
  advance: (ms: number) => void;
  config: IssuerServiceConfig;
}

function fixture(
  options: {
    issuerResult?: (method: string) => unknown;
    accounts?: boolean[];
    claim?: unknown;
  } = {},
): Fixture {
  let now = 1_800_000_000_000;
  const config: IssuerServiceConfig = {
    rootAccount: ROOT,
    requiredDepositYocto: REQUIRED_ISSUE_DEPOSIT_YOCTO,
    reservationTtlMs: 60_000,
    accountWaitMs: 3,
    accountPollMs: 1,
    now: () => now,
    sleep: async () => {},
  };
  const issuer = new FakeNear(options.issuerResult, options.claim);
  const relay = new FakeNear();
  const state = new FakeState();
  const accounts = new FakeAccounts(options.accounts ?? [true]);
  const service = new IssuerService({
    issuerNear: issuer,
    relayNear: relay,
    state,
    accounts,
    config,
    logger,
  });
  return { service, issuer, relay, state, accounts, advance: (ms) => (now += ms), config };
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
  it("reserves the exact next token id and reads storage credit", async () => {
    const { service } = fixture();
    const result = await service.prepareIssue("acme.near");
    expect(result.tokenId).toBe("c-5");
    expect(result.claimAccount).toBe("c-5.openrail.near");
    expect(result.account).toBe(ROOT);
    expect(result.amount).toBe(REQUIRED_ISSUE_DEPOSIT_YOCTO.toString());
    expect(result.storageCredit).toBe((2n * 10n ** 22n).toString());
  });

  it("refuses a second prepare while one is in flight", async () => {
    const { service } = fixture();
    await service.prepareIssue("acme.near");
    await expect(service.prepareIssue("other.near")).rejects.toMatchObject({
      status: 409,
      code: "ISSUE_IN_FLIGHT",
    });
  });

  it("allows a new prepare after the reservation expires", async () => {
    const { service, advance, config } = fixture();
    await service.prepareIssue("acme.near");
    advance(config.reservationTtlMs + 1);
    await expect(service.prepareIssue("acme.near")).resolves.toMatchObject({
      tokenId: "c-5",
    });
  });
});

describe("issuer issueFor", () => {
  it("signs issue_for with the issuer key, maps the args and returns the tx", async () => {
    const { service, issuer } = fixture({ issuerResult: () => ok("c-5") });
    await service.prepareIssue("acme.near");

    const result = await service.issueFor(ISSUE);

    expect(result).toEqual({ txHash: "tx-1", tokenId: "c-5" });
    expect(issuer.calls).toHaveLength(1);
    expect(issuer.calls[0]?.methodName).toBe("issue_for");
    expect(issuer.calls[0]?.gas).toBe(250_000_000_000_000n);
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

  it("refuses an issue without a prepared reservation", async () => {
    const { service, issuer } = fixture();
    await expect(service.issueFor(ISSUE)).rejects.toMatchObject({
      status: 409,
      code: "NO_PREPARED_ISSUE",
    });
    expect(issuer.calls).toHaveLength(0);
  });

  it("refuses when the chain token id moved after prepare", async () => {
    const { service, issuer, state } = fixture();
    await service.prepareIssue("acme.near");
    state.next = 6;
    await expect(service.issueFor(ISSUE)).rejects.toMatchObject({
      status: 409,
      code: "TOKEN_ID_RACE",
    });
    expect(issuer.calls).toHaveLength(0);
  });

  it("waits for the claim account to exist", async () => {
    const { service, accounts } = fixture({
      issuerResult: () => ok("c-5"),
      accounts: [false, false, true],
    });
    await service.prepareIssue("acme.near");
    await service.issueFor(ISSUE);
    expect(accounts.calls).toEqual(["c-5.openrail.near", "c-5.openrail.near", "c-5.openrail.near"]);
  });

  it("fails when the claim account never appears", async () => {
    const { service } = fixture({
      issuerResult: () => ok("c-5"),
      accounts: [false, false, false],
    });
    await service.prepareIssue("acme.near");
    await expect(service.issueFor(ISSUE)).rejects.toMatchObject({
      status: 504,
      code: "CLAIM_ACCOUNT_NOT_READY",
    });
  });

  it("surfaces a failed transaction", async () => {
    const { service } = fixture({ issuerResult: () => failed() });
    await service.prepareIssue("acme.near");
    await expect(service.issueFor(ISSUE)).rejects.toMatchObject({
      status: 502,
      code: "NEAR_CALL_FAILED",
    });
  });
});

describe("issuer logQuote and acknowledgeEvm", () => {
  it("maps logQuote to the contract Quote shape", async () => {
    const { service, issuer } = fixture();
    const result = await service.logQuote(QUOTE);
    expect(result).toEqual({ txHash: "tx-1" });
    expect(issuer.calls[0]?.methodName).toBe("log_quote");
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
      state: new FakeState(),
      accounts: new FakeAccounts([true]),
      config: {
        rootAccount: ROOT,
        requiredDepositYocto: REQUIRED_ISSUE_DEPOSIT_YOCTO,
        reservationTtlMs: 60_000,
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

describe("issuer reservation isolation", () => {
  it("does not let another business consume a reservation", async () => {
    const { service, issuer } = fixture();
    await service.prepareIssue("acme.near");
    await expect(service.issueFor({ ...ISSUE, business: "other.near" })).rejects.toBeInstanceOf(
      IssuerError,
    );
    expect(issuer.calls).toHaveLength(0);
  });
});
