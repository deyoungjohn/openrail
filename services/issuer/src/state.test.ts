import { describe, expect, it } from "vitest";
import { RpcAccountChecker, RpcStateReader, borshString, type FetchLike } from "./state.js";

const ROOT = "openrail.near";

function stateFetch(handler: (params: Record<string, unknown>) => unknown): FetchLike {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { params: Record<string, unknown> };
    const result = handler(body.params);
    if (result instanceof Error) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: result.message } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function u64Tail(value: bigint): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeBigUInt64LE(value, buffer.length - 8);
  return buffer;
}

function u128(value: bigint): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buffer.writeBigUInt64LE(value >> 64n, 8);
  return buffer;
}

describe("issuer raw state reads", () => {
  it("reads next_token_id from the last state field", async () => {
    const key = Buffer.from("STATE");
    const fetchImpl = stateFetch(() => ({
      values: [{ key: key.toString("base64"), value: u64Tail(5n).toString("base64") }],
    }));
    const reader = new RpcStateReader(ROOT, ["https://rpc.test"], fetchImpl);
    await expect(reader.nextTokenId()).resolves.toBe(5);
  });

  it("rejects a missing STATE value", async () => {
    const reader = new RpcStateReader(
      ROOT,
      ["https://rpc.test"],
      stateFetch(() => ({ values: [] })),
    );
    await expect(reader.nextTokenId()).rejects.toThrow("contract STATE");
  });

  it("reads storage_credit[business] from the s: LookupMap key", async () => {
    const key = Buffer.concat([Buffer.from("s:"), borshString("acme.near")]);
    const expected = 42n + (1n << 64n);
    const fetchImpl = stateFetch((params) => {
      expect(params.prefix_base64).toBe(key.toString("base64"));
      return {
        values: [{ key: key.toString("base64"), value: u128(expected).toString("base64") }],
      };
    });
    const reader = new RpcStateReader(ROOT, ["https://rpc.test"], fetchImpl);
    await expect(reader.storageCredit("acme.near")).resolves.toBe(expected);
  });

  it("returns zero when the business has no credit entry", async () => {
    const reader = new RpcStateReader(
      ROOT,
      ["https://rpc.test"],
      stateFetch(() => ({ values: [] })),
    );
    await expect(reader.storageCredit("acme.near")).resolves.toBe(0n);
  });

  it("rejects a storage credit value of the wrong length", async () => {
    const key = Buffer.concat([Buffer.from("s:"), borshString("acme.near")]);
    const reader = new RpcStateReader(
      ROOT,
      ["https://rpc.test"],
      stateFetch(() => ({
        values: [{ key: key.toString("base64"), value: Buffer.alloc(15).toString("base64") }],
      })),
    );
    await expect(reader.storageCredit("acme.near")).rejects.toThrow("U128");
  });
});

describe("issuer claim account checker", () => {
  it("is true when view_account succeeds", async () => {
    const checker = new RpcAccountChecker(
      ["https://rpc.test"],
      stateFetch(() => ({ amount: "1" })),
    );
    await expect(checker.exists("c-5.openrail.near")).resolves.toBe(true);
  });

  it("is false when view_account fails", async () => {
    const checker = new RpcAccountChecker(
      ["https://rpc.test"],
      stateFetch(() => new Error("UNKNOWN_ACCOUNT")),
    );
    await expect(checker.exists("c-5.openrail.near")).resolves.toBe(false);
  });
});
