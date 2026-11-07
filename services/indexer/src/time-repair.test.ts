import { describe, expect, it } from "vitest";
import { repairTimes } from "./time-repair.js";

const store = (
  txs: { txHash: string; blockHeight: number }[],
  written: Array<[string, number]>,
) => ({
  badTimeTxs: () => txs,
  setTxTime: (hash: string, seconds: number) => written.push([hash, seconds]),
});

describe("repairTimes", () => {
  it("takes the block time from an RPC node, one call per block, and writes it for every transaction in it", async () => {
    const written: Array<[string, number]> = [];
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return Response.json({ result: { header: { timestamp: "1794045036940238755" } } });
    };
    const fixed = await repairTimes({
      store: store(
        [
          { txHash: "a", blockHeight: 9 },
          { txHash: "b", blockHeight: 9 },
        ],
        written,
      ),
      rpcUrls: ["https://rpc.test"],
      fetchImpl,
    });
    expect(fixed).toBe(2);
    expect(calls).toBe(1);
    expect(written).toEqual([
      ["a", 1794045036],
      ["b", 1794045036],
    ]);
  });

  it("asks NearBlocks only for blocks the node no longer has, and leaves what nobody can answer", async () => {
    const written: Array<[string, number]> = [];
    const fetchImpl = async (input: string) => {
      if (input.startsWith("https://rpc.test"))
        return Response.json({ error: { name: "UNKNOWN_BLOCK" } });
      if (input.endsWith("/tx1"))
        return Response.json({ txns: [{ block_timestamp: "1794045036940238755" }] });
      return Response.json({ txns: [] });
    };
    const fixed = await repairTimes({
      store: store(
        [
          { txHash: "tx1", blockHeight: 5 },
          { txHash: "tx2", blockHeight: 6 },
        ],
        written,
      ),
      rpcUrls: ["https://rpc.test"],
      baseUrl: "https://nb.test/",
      fetchImpl,
    });
    expect(fixed).toBe(1);
    expect(written).toEqual([["tx1", 1794045036]]);
  });
});
