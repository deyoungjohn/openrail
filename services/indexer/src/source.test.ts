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

describe("RPC event source (off by default)", () => {
  it("starts at the stored height and reports the final head", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: { finality?: string; block_id?: number };
      };
      calls.push(body.method);
      if (body.method === "block" && body.params.finality === "final") {
        return rpc({ header: { height: 103 } });
      }
      if (body.method === "block") {
        return rpc({
          header: { height: 103, hash: "H103", timestamp: "1793613660000000000" },
          chunks: [],
        });
      }
      return rpc({});
    };
    const page = await new RpcEventSource(
      "openrail.near",
      ["https://rpc.test"],
      103,
      fetchImpl,
    ).fetch(null);
    expect(page.latestBlock).toBe(103);
    expect(page.blocks.map((block) => block.height)).toEqual([103]);
    expect(page.cursor).toBe("h:103");
    expect(calls).toEqual(["block", "block"]);
  });

  it("scans a final block, keeps root transactions and extracts receipt logs", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      calls.push(body.method);
      if (body.method === "block") {
        const params = body.params as { block_id?: number; finality?: string };
        if (params.finality === "final") return rpc({ header: { height: 100 } });
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

    const page = await new RpcEventSource(
      "openrail.near",
      ["https://rpc.test"],
      100,
      fetchImpl,
    ).fetch("h:99");

    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]?.height).toBe(100);
    expect(page.blocks[0]?.timestamp).toBe(1793613600);
    expect(page.blocks[0]?.receipts).toHaveLength(1);
    expect(page.blocks[0]?.receipts[0]?.txHash).toBe("Tx1");
    expect(page.blocks[0]?.receipts[0]?.logs[0]).toBe(LOG);
    expect(calls).toEqual(["block", "block", "chunk", "tx"]);
  });
});
