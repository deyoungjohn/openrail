import { describe, expect, it } from "vitest";
import { repairTimes } from "./time-repair.js";

describe("repairTimes", () => {
  it("writes the block time of each transaction with a time in 1970, and leaves the others", async () => {
    const written: Array<[string, number]> = [];
    const store = {
      txHashesWithBadTime: () => ["tx1", "tx2", "tx3"],
      setTxTime: (hash: string, seconds: number) => written.push([hash, seconds]),
    };
    const fetchImpl = async (input: string) => {
      if (input.endsWith("/tx1"))
        return Response.json({ txns: [{ block_timestamp: "1794045036940238755" }] });
      if (input.endsWith("/tx2")) return Response.json({ txns: [] });
      return new Response("nope", { status: 500 });
    };
    const fixed = await repairTimes({ store, baseUrl: "https://nb.test/", fetchImpl });
    expect(fixed).toBe(1);
    expect(written).toEqual([["tx1", 1794045036]]);
  });
});
