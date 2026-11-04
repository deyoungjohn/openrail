import { describe, expect, it } from "vitest";
import { Indexer } from "./indexer.js";
import { FakeSource, ROOT, loadBlocks, memoryStore, silentLogger } from "./test-support.js";

const block = loadBlocks()[0]!;

function indexer(receiver = ROOT) {
  return new Indexer({
    source: new FakeSource([]),
    store: memoryStore(),
    rootAccount: ROOT,
    txStatus: {
      fetch: async () => ({
        receiverId: receiver,
        signerId: "signer.near",
        blockHeight: block.height,
        blockHash: block.hash,
        blockTimestamp: block.timestamp,
        receipts: block.receipts,
      }),
    },
    logger: silentLogger(),
  });
}

describe("register-tx", () => {
  it("accepts a transaction to the root and ingests its events", async () => {
    const result = await indexer().registerTx("tx-1", "signer.near");
    expect(result.accepted).toBe(true);
    expect(result.events).toBeGreaterThan(0);
  });

  it("accepts a transaction to a claim account", async () => {
    const result = await indexer(`c-1.${ROOT}`).registerTx("tx-2", "signer.near");
    expect(result.accepted).toBe(true);
  });

  it("refuses a transaction to another account", async () => {
    const result = await indexer("other.near").registerTx("tx-3", "signer.near");
    expect(result).toEqual({ accepted: false, reason: "receiver_not_root", events: 0 });
  });
});
