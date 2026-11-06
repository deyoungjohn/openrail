import type { ViewRequest } from "@openrail/shared";
import { describe, expect, it } from "vitest";
import {
  ContractStorageCreditReader,
  RpcAccountChecker,
  RpcKeyInspector,
  type FetchLike,
  ContractTokenCounter,
} from "./chain.js";
import type { NearClientLike } from "./types.js";

const ROOT = "openrail.near";

function rpcFetch(handler: (params: Record<string, unknown>) => unknown): FetchLike {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { params: Record<string, unknown> };
    const result = handler(body.params);
    if (result instanceof Error) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: result.message } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("issuer key inspector", () => {
  it("reads a restricted function-call key and its allowance", async () => {
    const inspector = new RpcKeyInspector(
      ["https://rpc.test"],
      rpcFetch((params) => {
        expect(params.request_type).toBe("view_access_key");
        expect(params.public_key).toBe("ed25519:key");
        return {
          permission: {
            FunctionCall: {
              allowance: "1500000000000000000000000",
              receiver_id: ROOT,
              method_names: ["issue_for", "log_quote"],
            },
          },
        };
      }),
    );
    await expect(inspector.keyInfo(ROOT, "ed25519:key")).resolves.toEqual({
      kind: "FunctionCall",
      methods: ["issue_for", "log_quote"],
      allowance: "1500000000000000000000000",
    });
  });

  it("recognises a full-access key", async () => {
    const inspector = new RpcKeyInspector(
      ["https://rpc.test"],
      rpcFetch(() => ({ permission: "FullAccess" })),
    );
    await expect(inspector.keyInfo(ROOT, "ed25519:key")).resolves.toEqual({
      kind: "FullAccess",
      methods: [],
      allowance: null,
    });
  });

  it("fails when the key does not exist", async () => {
    const inspector = new RpcKeyInspector(
      ["https://rpc.test"],
      rpcFetch(() => new Error("UNKNOWN_KEY")),
    );
    await expect(inspector.keyInfo(ROOT, "ed25519:key")).rejects.toThrow("UNKNOWN_KEY");
  });
});

describe("issuer account checker", () => {
  it("is true when view_account succeeds and false otherwise", async () => {
    const ok = new RpcAccountChecker(
      ["https://rpc.test"],
      rpcFetch(() => ({ amount: "1" })),
    );
    await expect(ok.exists("c-5.openrail.near")).resolves.toBe(true);

    const missing = new RpcAccountChecker(
      ["https://rpc.test"],
      rpcFetch(() => new Error("UNKNOWN_ACCOUNT")),
    );
    await expect(missing.exists("c-5.openrail.near")).resolves.toBe(false);
  });
});

describe("issuer storage credit view", () => {
  it("reads storage_credit_of through the shared client", async () => {
    const requests: ViewRequest[] = [];
    const near: NearClientLike = {
      async view<T>(request: ViewRequest): Promise<T> {
        requests.push(request);
        return "42" as T;
      },
      async sendFunctionCall(): Promise<unknown> {
        throw new Error("not used");
      },
    };
    const reader = new ContractStorageCreditReader(near, ROOT);
    await expect(reader.storageCreditOf("acme.near")).resolves.toBe(42n);
    expect(requests[0]).toMatchObject({
      contractId: ROOT,
      methodName: "storage_credit_of",
      args: { account_id: "acme.near" },
    });
  });

  it("rejects a malformed U128 result", async () => {
    const near: NearClientLike = {
      async view<T>(): Promise<T> {
        return "not-a-number" as T;
      },
      async sendFunctionCall(): Promise<unknown> {
        throw new Error("not used");
      },
    };
    const reader = new ContractStorageCreditReader(near, ROOT);
    await expect(reader.storageCreditOf("acme.near")).rejects.toThrow(
      "ISSUER_STORAGE_CREDIT_INVALID",
    );
  });
});

describe("ContractTokenCounter", () => {
  const near = (views: Record<string, unknown>, errors: Record<string, Error> = {}) => ({
    sendFunctionCall: async () => null,
    view: async <T>(request: { methodName: string }): Promise<T> => {
      const error = errors[request.methodName];
      if (error !== undefined) throw error;
      return views[request.methodName] as T;
    },
  });
  const missing = () =>
    new Error(
      'RPC_ERROR: {"cause":{"name":"FunctionCallError","info":{"error_message":"MethodNotFound"}}}',
    );

  it("reads the next id from the view", async () => {
    const counter = new ContractTokenCounter(near({ next_token_id: 1 }) as never, "openrail.near");
    expect(await counter.nextTokenId()).toBe(1);
    const later = new ContractTokenCounter(near({ next_token_id: 8 }) as never, "openrail.near");
    expect(await later.nextTokenId()).toBe(8);
  });

  it("falls back to the newest token on a contract without the view", async () => {
    const counter = new ContractTokenCounter(
      near(
        { nft_total_supply: "3", nft_tokens: [{ token_id: "c-7" }] },
        { next_token_id: missing() },
      ) as never,
      "openrail.near",
    );
    expect(await counter.nextTokenId()).toBe(8);
    const empty = new ContractTokenCounter(
      near({ nft_total_supply: "0" }, { next_token_id: missing() }) as never,
      "openrail.near",
    );
    expect(await empty.nextTokenId()).toBe(1);
  });

  it("refuses a view answer it cannot read", async () => {
    const counter = new ContractTokenCounter(
      near({ next_token_id: "x" }) as never,
      "openrail.near",
    );
    await expect(counter.nextTokenId()).rejects.toThrow("ISSUER_NEXT_TOKEN_INVALID");
  });

  it("does not hide other view errors", async () => {
    const counter = new ContractTokenCounter(
      near({}, { next_token_id: new Error("RPC_HTTP_503") }) as never,
      "openrail.near",
    );
    await expect(counter.nextTokenId()).rejects.toThrow("RPC_HTTP_503");
  });
});
