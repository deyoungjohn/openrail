import { describe, expect, it } from "vitest";
import { Indexer } from "./indexer.js";
import { FakeSource, ROOT, loadBlocks, memoryStore, silentLogger } from "./test-support.js";

const block = loadBlocks()[0]!;
const LABEL = "belmonte-9f3c2a7d41b8";

function indexer(receiver = ROOT, tokenId = "c-1", seed = false) {
  const store = memoryStore();
  const seeded =
    tokenId === "c-1"
      ? block
      : {
          ...block,
          receipts: block.receipts.map((receipt) => ({
            ...receipt,
            logs: receipt.logs.map((entry) => entry.replaceAll('"c-1"', `"${tokenId}"`)),
          })),
        };
  if (seed) store.ingestBlock(seeded);
  return new Indexer({
    source: new FakeSource([]),
    store,
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

  it("accepts a transaction to a known numbered claim account", async () => {
    const result = await indexer(`c-1.${ROOT}`, "c-1", true).registerTx("tx-2", "signer.near");
    expect(result.accepted).toBe(true);
  });

  it("accepts a transaction to a known labelled claim account", async () => {
    const result = await indexer(`${LABEL}.${ROOT}`, LABEL, true).registerTx("tx-3", "signer.near");
    expect(result.accepted).toBe(true);
  });

  it("refuses an unknown account under the root", async () => {
    const result = await indexer(`stranger-000000000000.${ROOT}`).registerTx("tx-4", "signer.near");
    expect(result).toEqual({ accepted: false, reason: "receiver_not_root", events: 0 });
  });

  it("refuses a transaction to another account", async () => {
    const result = await indexer("other.near").registerTx("tx-5", "signer.near");
    expect(result).toEqual({ accepted: false, reason: "receiver_not_root", events: 0 });
  });
});
