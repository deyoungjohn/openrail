import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLL_INTERVAL_MS } from "./indexer.js";
import { NearBlocksEventSource, type FetchLike } from "./nearblocks.js";
import { loadBlocks } from "./test-support.js";

const BOOKED = loadBlocks()[1]?.receipts[0]?.logs[0] ?? "";
const QUOTE = loadBlocks()[0]?.receipts[0]?.logs[2] ?? "";

interface TxnRow {
  transaction_hash: string;
  signer_account_id: string;
  receiver_account_id: string;
  included_in_block_hash: string;
  block_timestamp: string;
  block: { block_height: number };
}
const TXN = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./fixtures/txn.deploy-global.json", import.meta.url)),
      "utf8",
    ),
  ) as { txns: TxnRow[] }
).txns[0] as TxnRow;

function nbResponse(txns: unknown[], cursor: string | null = null): Response {
  return new Response(JSON.stringify({ cursor, txns }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rpcResponse(logs: string[], executor = "openrail.near"): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        receipts_outcome: [{ id: "Receipt1", outcome: { logs, executor_id: executor } }],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("NearBlocks account-scoped source", () => {
  it("discovers root transactions and reads their logs with EXPERIMENTAL_tx_status", async () => {
    let authorization = "";
    let statusCalls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("/v1/account/")) {
        authorization = String((init?.headers as Record<string, string>).authorization);
        return nbResponse([TXN]);
      }
      statusCalls += 1;
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: { tx_hash: string; sender_account_id: string; wait_until: string };
      };
      expect(body.method).toBe("EXPERIMENTAL_tx_status");
      expect(body.params).toMatchObject({
        tx_hash: TXN.transaction_hash,
        sender_account_id: "openrail.near",
        wait_until: "FINAL",
      });
      return rpcResponse([BOOKED, QUOTE]);
    };
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "secret-key",
      ["https://rpc.test"],
      fetchImpl,
    );

    const page = await source.fetch(null);

    expect(authorization).toBe("Bearer secret-key");
    expect(statusCalls).toBe(1);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]?.height).toBe(TXN.block.block_height);
    expect(page.blocks[0]?.timestamp).toBe(1793617822);
    expect(page.blocks[0]?.receipts[0]?.txHash).toBe(TXN.transaction_hash);
    expect(page.blocks[0]?.receipts[0]?.logs).toEqual([BOOKED, QUOTE]);
    expect(page.cursor).toBe(`h:${TXN.block.block_height}`);
    expect(source.callCounts()).toEqual({
      "nearblocks.txns": 1,
      "rpc.tx_status": 1,
    });
  });

  it("skips transactions at or below the stored height without an RPC call", async () => {
    let rpcCalls = 0;
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) => {
        if (url.includes("/v1/account/")) return nbResponse([TXN]);
        rpcCalls += 1;
        return rpcResponse([BOOKED]);
      },
    );
    const page = await source.fetch(`h:${TXN.block.block_height}`);
    expect(page.blocks).toHaveLength(0);
    expect(rpcCalls).toBe(0);
    expect(page.cursor).toBe(`h:${TXN.block.block_height}`);
  });

  it("only keeps logs from receipts executed by the root account", async () => {
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) =>
        url.includes("/v1/account/")
          ? nbResponse([TXN])
          : rpcResponse([BOOKED], "someone.else.near"),
    );
    const page = await source.fetch(null);
    expect(page.blocks).toHaveLength(0);
    expect(page.latestBlock).toBe(TXN.block.block_height);
  });

  it("walks older pages until it reaches already-indexed heights", async () => {
    const urls: string[] = [];
    const older = {
      ...TXN,
      transaction_hash: "OlderTx",
      block: { block_height: TXN.block.block_height - 1 },
    };
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) => {
        urls.push(url);
        if (url.includes("/v1/account/")) {
          return urls.filter((entry) => entry.includes("/v1/account/")).length === 1
            ? nbResponse([TXN], "p2")
            : nbResponse([older], null);
        }
        return rpcResponse([BOOKED]);
      },
    );
    const page = await source.fetch(`h:${TXN.block.block_height - 2}`);
    expect(page.blocks.map((block) => block.height)).toEqual([
      TXN.block.block_height - 1,
      TXN.block.block_height,
    ]);
    expect(urls.filter((url) => url.includes("/v1/account/"))).toHaveLength(2);
  });

  it("a quiet hour costs a few hundred NearBlocks calls and no RPC calls", async () => {
    let listCalls = 0;
    let rpcCalls = 0;
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) => {
        if (url.includes("/v1/account/")) {
          listCalls += 1;
          return nbResponse([]);
        }
        rpcCalls += 1;
        return rpcResponse([]);
      },
    );
    const quietPolls = Math.ceil(3_600_000 / DEFAULT_POLL_INTERVAL_MS);
    for (let poll = 0; poll < quietPolls; poll += 1) await source.fetch(null);
    expect(quietPolls).toBe(240);
    expect(quietPolls).toBeLessThanOrEqual(300);
    expect(listCalls).toBe(quietPolls);
    expect(rpcCalls).toBe(0);
  });

  it("surfaces a provider error to the indexer retry loop", async () => {
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async () => new Response("quota", { status: 429 }),
    );
    await expect(source.fetch(null)).rejects.toThrow("NEARBLOCKS_HTTP_429");
  });
});
