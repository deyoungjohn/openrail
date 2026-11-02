import { describe, expect, it } from "vitest";
import { RpcEventSource, type FetchLike } from "./source.js";
import { loadBlocks } from "./test-support.js";

const LOG = loadBlocks()[0]?.receipts[0]?.logs[0] ?? "";

function rpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("RPC event source", () => {
  it("reads the final head", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "block") return rpc({ header: { height: 103 } });
      return rpc({});
    };
    await expect(
      new RpcEventSource("openrail.near", ["https://rpc.test"], fetchImpl).finalHead(),
    ).resolves.toBe(103);
  });

  it("scans a final block, keeps root transactions and extracts receipt logs", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown;
      };
      calls.push(body.method);
      if (body.method === "block") {
        const params = body.params as { block_id?: number; finality?: string };
        if (params.finality === "final") return rpc({ header: { height: 103 } });
        return rpc({
          header: { height: 100, hash: "H100", timestamp: "1793613600000000000" },
          chunks: [{ chunk_hash: "C1" }],
        });
      }
      if (body.method === "chunk") {
        return rpc({
          transactions: [
            { hash: "Tx1", receiver_id: "openrail.near", signer_id: "acme.near" },
            { hash: "Tx2", receiver_id: "other.near", signer_id: "x.near" },
          ],
        });
      }
      if (body.method === "tx") {
        return rpc({
          receipts_outcome: [{ id: "R1", outcome: { logs: [LOG], executor_id: "openrail.near" } }],
        });
      }
      return rpc({});
    };

    const blocks = await new RpcEventSource(
      "openrail.near",
      ["https://rpc.test"],
      fetchImpl,
    ).fetchRange(100, 100);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.height).toBe(100);
    expect(blocks[0]?.timestamp).toBe(1793613600);
    expect(blocks[0]?.receipts).toHaveLength(1);
    expect(blocks[0]?.receipts[0]?.txHash).toBe("Tx1");
    expect(blocks[0]?.receipts[0]?.logs[0]).toBe(LOG);
    expect(calls).toEqual(["block", "chunk", "tx"]);
  });
});
