import { describe, expect, it } from "vitest";
import { DEFAULT_POLL_INTERVAL_MS } from "./indexer.js";
import { NearBlocksEventSource, type FetchLike } from "./nearblocks.js";
import { loadBlocks } from "./test-support.js";

const BOOKED = loadBlocks()[1]?.receipts[0]?.logs[0] ?? "";
const QUOTE = loadBlocks()[0]?.receipts[0]?.logs[2] ?? "";

interface NbNode {
  receipt_id: string;
  transaction_hash?: string;
  block: { block_height: number; block_timestamp: string; block_hash: string };
  outcome?: { logs?: string[] };
  receipts?: NbNode[];
}

function node(height: number, logs: string[], children: NbNode[] = []): NbNode {
  return {
    receipt_id: `R-${height}`,
    transaction_hash: `Tx-${height}`,
    block: {
      block_height: height,
      block_timestamp: `${1793613600 + (height - 100) * 60}000000000`,
      block_hash: `BlockHash${height}`,
    },
    outcome: { logs },
    receipts: children,
  };
}

function response(data: unknown[], next: string | null = null): Response {
  return new Response(JSON.stringify({ data, meta: { next_page: next } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("NearBlocks account-scoped source", () => {
  it("turns an account receipt page into blocks with logs and an opaque cursor", async () => {
    let authorization = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      authorization = String((init?.headers as Record<string, string>).authorization);
      return response([node(101, [BOOKED], [node(101, [QUOTE])])]);
    };
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "secret-key",
      fetchImpl,
    );

    const page = await source.fetch(null);

    expect(authorization).toBe("Bearer secret-key");
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]?.height).toBe(101);
    expect(page.blocks[0]?.timestamp).toBe(1793613660);
    expect(page.blocks[0]?.receipts.flatMap((receipt) => receipt.logs)).toEqual([BOOKED, QUOTE]);
    expect(page.cursor).toBe("h:101");
    expect(page.latestBlock).toBe(101);
    expect(source.callCounts()).toEqual({ "nearblocks.receipts": 1 });
  });

  it("filters events at or below the stored height", async () => {
    const source = new NearBlocksEventSource("openrail.near", "https://nb.test", "", async () =>
      response([node(101, [BOOKED])]),
    );
    const page = await source.fetch("h:101");
    expect(page.blocks).toHaveLength(0);
    expect(page.cursor).toBe("h:101");
  });

  it("walks older pages until it reaches already-indexed heights", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (urls.length === 1) return response([node(102, [BOOKED])], "p2");
      return response([node(101, [QUOTE])], null);
    };
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      fetchImpl,
      100,
      5,
    );
    const page = await source.fetch("h:100");
    expect(page.blocks.map((block) => block.height)).toEqual([101, 102]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("next=p2");
  });

  it("a quiet hour costs a few hundred calls, not a million", async () => {
    const source = new NearBlocksEventSource("openrail.near", "https://nb.test", "", async () =>
      response([]),
    );
    const quietPolls = Math.ceil(3_600_000 / DEFAULT_POLL_INTERVAL_MS);
    expect(quietPolls).toBeLessThanOrEqual(300);
    for (let poll = 0; poll < quietPolls; poll += 1) {
      await source.fetch(null);
    }
    expect(source.callCounts()["nearblocks.receipts"]).toBe(quietPolls);
    expect(quietPolls).toBe(240);
  });

  it("surfaces a provider error to the indexer retry loop", async () => {
    const source = new NearBlocksEventSource(
      "openrail.near",
      "https://nb.test",
      "",
      async () => new Response("quota", { status: 429 }),
    );
    await expect(source.fetch(null)).rejects.toThrow("NEARBLOCKS_HTTP_429");
  });
});
