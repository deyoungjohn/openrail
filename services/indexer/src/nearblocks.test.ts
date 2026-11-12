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
  block: { block_height: string; block_timestamp: string; block_hash: string };
}
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/nearblocks.v3.txns.json", import.meta.url)),
    "utf8",
  ),
) as { data: TxnRow[]; meta: { next_page: string } };
const TXN = FIXTURE.data[0] as TxnRow;
const OLDER = FIXTURE.data[1] as TxnRow;
const HEIGHT = Number(TXN.block.block_height);

function nbResponse(txns: unknown[], nextPage: string | null = null): Response {
  return new Response(JSON.stringify({ data: txns, meta: { next_page: nextPage } }), {
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
  it("parses a real v3 page and reads logs with EXPERIMENTAL_tx_status", async () => {
    let url = "";
    let authorization = "";
    let statusCalls = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      if (input.includes("/v3/accounts/")) {
        url = input;
        authorization = String((init?.headers as Record<string, string>).authorization);
        return nbResponse([TXN], null);
      }
      statusCalls += 1;
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: { tx_hash: string; sender_account_id: string; wait_until: string };
      };
      expect(body.method).toBe("EXPERIMENTAL_tx_status");
      expect(body.params).toMatchObject({
        tx_hash: TXN.transaction_hash,
        sender_account_id: "watcher.openrail.near",
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

    expect(url).toContain("/v3/accounts/openrail.near/txns?");
    expect(url).toContain("limit=25");
    expect(authorization).toBe("Bearer secret-key");
    expect(statusCalls).toBe(1);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]?.height).toBe(HEIGHT);
    expect(page.blocks[0]?.timestamp).toBe(1794478343);
    expect(page.blocks[0]?.receipts[0]?.txHash).toBe(TXN.transaction_hash);
    expect(page.blocks[0]?.receipts[0]?.logs).toEqual([BOOKED, QUOTE]);
    expect(page.cursor).toBe(`v3:${HEIGHT}:${HEIGHT}:`);
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
        if (url.includes("/v3/accounts/")) return nbResponse([TXN]);
        rpcCalls += 1;
        return rpcResponse([BOOKED]);
      },
    );
    const page = await source.fetch(`v3:${HEIGHT}:${HEIGHT}:`);
    expect(page.blocks).toHaveLength(0);
    expect(rpcCalls).toBe(0);
    expect(page.cursor).toBe(`v3:${HEIGHT}:${HEIGHT}:`);
  });

  it("only keeps logs from receipts executed by the root account", async () => {
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) =>
        url.includes("/v3/accounts/")
          ? nbResponse([TXN])
          : rpcResponse([BOOKED], "someone.else.near"),
    );
    const page = await source.fetch(null);
    expect(page.blocks).toHaveLength(0);
    expect(page.latestBlock).toBe(HEIGHT);
  });

  it("keeps v3's opaque next page while a backlog is walked", async () => {
    const urls: string[] = [];
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) => {
        urls.push(url);
        if (!url.includes("/v3/accounts/")) return rpcResponse([BOOKED]);
        return urls.filter((entry) => entry.includes("/v3/accounts/")).length === 1
          ? nbResponse([TXN], FIXTURE.meta.next_page)
          : nbResponse([OLDER], null);
      },
      100,
      1,
    );
    const first = await source.fetch(null);
    expect(first.done).toBe(false);
    expect(first.cursor).toBe(
      `v3:${HEIGHT}:0:${Buffer.from(FIXTURE.meta.next_page).toString("base64url")}`,
    );

    const second = await source.fetch(first.cursor);
    expect(urls.find((entry) => entry.includes("next="))).toBeDefined();
    expect(second.blocks.map((block) => block.height)).toEqual([Number(OLDER.block.block_height)]);
    expect(second.done).toBe(true);
    expect(second.latestBlock).toBe(HEIGHT);
  });

  it("walks backwards until it reaches already-indexed heights", async () => {
    const urls: string[] = [];
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) => {
        urls.push(url);
        if (!url.includes("/v3/accounts/")) return rpcResponse([BOOKED]);
        return urls.filter((entry) => entry.includes("/v3/accounts/")).length === 1
          ? nbResponse([TXN], "p2")
          : nbResponse([OLDER], null);
      },
    );
    const page = await source.fetch(
      `v3:${Number(OLDER.block.block_height) - 1}:${Number(OLDER.block.block_height) - 1}:`,
    );
    expect(page.blocks.map((block) => block.height)).toEqual([
      Number(OLDER.block.block_height),
      HEIGHT,
    ]);
    expect(urls.filter((entry) => entry.includes("/v3/accounts/"))).toHaveLength(2);
  });

  it("a quiet hour costs two NearBlocks calls and no RPC calls", async () => {
    let listCalls = 0;
    let rpcCalls = 0;
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) => {
        if (url.includes("/v3/accounts/")) {
          listCalls += 1;
          return nbResponse([]);
        }
        rpcCalls += 1;
        return rpcResponse([]);
      },
    );
    const quietPolls = Math.ceil(3_600_000 / DEFAULT_POLL_INTERVAL_MS);
    for (let poll = 0; poll < quietPolls; poll += 1) await source.fetch(null);
    expect(quietPolls).toBe(2);
    expect(quietPolls).toBeLessThanOrEqual(300);
    expect(listCalls).toBe(quietPolls);
    expect(rpcCalls).toBe(0);
  });

  it("INDEXER_FROM skips older rows and stops after the newest page", async () => {
    let listCalls = 0;
    let rpcCalls = 0;
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) => {
        if (url.includes("/v3/accounts/")) {
          listCalls += 1;
          return nbResponse([TXN], FIXTURE.meta.next_page);
        }
        rpcCalls += 1;
        return rpcResponse([BOOKED]);
      },
      100,
      5,
      undefined,
      1794478400,
    );
    const page = await source.fetch(null);
    expect(listCalls).toBe(1);
    expect(rpcCalls).toBe(0);
    expect(page.blocks).toEqual([]);
    expect(page.done).toBe(true);
    expect(source.caughtUp()).toBe(true);
    expect(page.cursor).toBe(`v3:${HEIGHT}:${HEIGHT}:`);
  });

  it("a known transaction costs no tx-status call during a gap backfill", async () => {
    let rpcCalls = 0;
    const source = new NearBlocksEventSource(
      "c-1.openrail.near",
      "https://nb.test",
      "",
      ["https://rpc.test"],
      async (url) => {
        if (url.includes("/v3/accounts/")) return nbResponse([TXN]);
        rpcCalls += 1;
        return rpcResponse([BOOKED]);
      },
      25,
      5,
      undefined,
      0,
      (hash) => hash !== TXN.transaction_hash,
    );
    const page = await source.fetch(null);
    expect(page.blocks).toHaveLength(0);
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

  it("has no v1 or v2 route left in the source", () => {
    const source = readFileSync(fileURLToPath(new URL("./nearblocks.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/\/v[12]\//);
  });
});
