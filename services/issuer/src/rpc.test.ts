/**
 * End-to-end through the real `@openrail/shared` NearClient with a fake JSON-RPC (no network):
 * issue_for and acknowledge_evm sign with the right key and the service maps the result.
 */
import { NearClient, createLogger } from "@openrail/shared";
import { KeyPair } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./chain.js";
import { IssuerService, REQUIRED_ISSUE_DEPOSIT_YOCTO } from "./service.js";
import type { AccountChecker, AckEvmRequest, StorageCreditReader } from "./types.js";

const ROOT = "openrail.near";
const ZERO_HASH = "1".repeat(32);
const logger = createLogger("issuer-rpc-test", () => {});

class Credit implements StorageCreditReader {
  async storageCreditOf(): Promise<bigint> {
    return 0n;
  }
}

class Accounts implements AccountChecker {
  async exists(): Promise<boolean> {
    return true;
  }
}

function bytesOf(value: unknown): number[] {
  return Array.from(new TextEncoder().encode(JSON.stringify(value)));
}

function reply(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function callResult(value: unknown): Response {
  return reply({ result: bytesOf(value), logs: [], block_height: 1, block_hash: ZERO_HASH });
}

function makeFetch(returnTokenId = false): { fetchImpl: FetchLike; broadcasts: string[] } {
  const broadcasts: string[] = [];
  const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    if (body.method === "block") {
      return reply({ header: { height: 1, hash: ZERO_HASH } });
    }
    if (body.method === "query") {
      const params = body.params as { request_type?: string; method_name?: string };
      if (params.request_type === "view_access_key") {
        return reply({ nonce: 1, block_hash: ZERO_HASH });
      }
      if (params.request_type === "call_function" && params.method_name === "claim") {
        return callResult({ ack: null });
      }
    }
    if (body.method === "broadcast_tx_commit") {
      const tx = String((body.params as string[])[0]);
      broadcasts.push(tx);
      return reply({
        transaction: { hash: "tx-1" },
        status: {
          SuccessValue: returnTokenId ? Buffer.from(JSON.stringify("c-5")).toString("base64") : "",
        },
      });
    }
    return new Response(JSON.stringify({ error: { message: "unexpected" } }), { status: 400 });
  }) as FetchLike;
  return { fetchImpl, broadcasts };
}

function client(fetchImpl: FetchLike, accountEnv: string, keyEnv: string): NearClient {
  return new NearClient({
    rpcUrls: ["https://rpc.test"],
    fetchImpl,
    signer: { accountIdEnv: accountEnv, privateKeyEnv: keyEnv },
  });
}

function signedBy(tx: string, signerAccount: string): boolean {
  return Buffer.from(tx, "base64").toString("latin1").includes(signerAccount);
}

beforeEach(() => {
  process.env.ISSUER_TEST_ACCOUNT = "issuer.test.near";
  process.env.ISSUER_TEST_KEY = KeyPair.fromRandom("ed25519").toString();
  process.env.RELAY_TEST_ACCOUNT = "relay.test.near";
  process.env.RELAY_TEST_KEY = KeyPair.fromRandom("ed25519").toString();
});

afterEach(() => {
  for (const name of [
    "ISSUER_TEST_ACCOUNT",
    "ISSUER_TEST_KEY",
    "RELAY_TEST_ACCOUNT",
    "RELAY_TEST_KEY",
  ]) {
    delete process.env[name];
  }
  vi.restoreAllMocks();
});

function service(fetchImpl: FetchLike): IssuerService {
  return new IssuerService({
    issuerNear: client(fetchImpl, "ISSUER_TEST_ACCOUNT", "ISSUER_TEST_KEY"),
    relayNear: client(fetchImpl, "RELAY_TEST_ACCOUNT", "RELAY_TEST_KEY"),
    credit: new Credit(),
    accounts: new Accounts(),
    logger,
    config: {
      rootAccount: ROOT,
      requiredDepositYocto: REQUIRED_ISSUE_DEPOSIT_YOCTO,
      accountWaitMs: 2,
      accountPollMs: 1,
      now: () => 1_800_000_000_000,
      sleep: async () => {},
    },
  });
}

describe("issuer with the shared near client and a fake RPC", () => {
  it("signs issue_for with the issuer key and derives the claim account", async () => {
    const { fetchImpl, broadcasts } = makeFetch(true);
    const issuer = service(fetchImpl);

    const result = await issuer.issueFor({
      business: "acme.near",
      kind: 0,
      debtor: { Near: "client.near" },
      termsHash: "0x" + "11".repeat(32),
      amountDue: "1000000",
      dueDate: 1_800_000_000,
    });

    expect(result).toEqual({
      txHash: "tx-1",
      tokenId: "c-5",
      claimAccount: "c-5.openrail.near",
    });
    expect(broadcasts).toHaveLength(1);
    expect(Buffer.from(broadcasts[0] ?? "", "base64").toString("latin1")).toContain("issue_for");
    expect(signedBy(broadcasts[0] ?? "", "issuer.test.near")).toBe(true);
    expect(signedBy(broadcasts[0] ?? "", "relay.test.near")).toBe(false);
  });

  it("signs acknowledge_evm with the relay key, not the issuer key", async () => {
    const { fetchImpl, broadcasts } = makeFetch();
    const issuer = service(fetchImpl);

    const request: AckEvmRequest = {
      tokenId: "c-5",
      chainId: 8453,
      signature: "0x" + "33".repeat(65),
    };
    await issuer.acknowledgeEvm(request);

    expect(broadcasts).toHaveLength(1);
    expect(Buffer.from(broadcasts[0] ?? "", "base64").toString("latin1")).toContain(
      "acknowledge_evm",
    );
    expect(signedBy(broadcasts[0] ?? "", "relay.test.near")).toBe(true);
    expect(signedBy(broadcasts[0] ?? "", "issuer.test.near")).toBe(false);
  });
});
