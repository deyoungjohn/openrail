import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createHttpIndexer } from "./indexer-client.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/indexer/${name}`, import.meta.url), "utf8"));

function fakeFetch() {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/events")
      return new Response(JSON.stringify(fixture("events.json")), { status: 200 });
    if (url.pathname.startsWith("/r/"))
      return new Response(JSON.stringify(fixture("receipt.json")), { status: 200 });
    if (url.pathname === "/statements")
      return new Response(JSON.stringify(fixture("statement.json")), { status: 200 });
    return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
  });
}

describe("HTTP indexer client", () => {
  it("maps events from the /events cursor page", async () => {
    const fetchImpl = fakeFetch();
    const indexer = createHttpIndexer("http://indexer.test", fetchImpl);
    const page = await indexer.listEvents({ after: "3", limit: 10 });
    expect(page.data[0]).toMatchObject({
      id: "7",
      type: "booked",
      created: Math.floor(Date.parse("2026-11-02T10:01:35Z") / 1000),
    });
    expect(page.data[0]?.data).toMatchObject({
      token_id: "c-1",
      tx_hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    expect(page.next_cursor).toBe("7");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://indexer.test/events?limit=10&after=3");
  });

  it("reads a statement envelope", async () => {
    const indexer = createHttpIndexer("http://indexer.test", fakeFetch());
    const statement = await indexer.getStatement("acme.near", {
      format: "csv",
      from: "2026-11-01",
      to: "2026-11-30",
      tokenId: "c-1",
    });
    expect(statement).toEqual(fixture("statement.json"));
  });

  it("reads a receipt by booking hash", async () => {
    const indexer = createHttpIndexer("http://indexer.test", fakeFetch());
    const receipt = await indexer.getReceipt("0xcccc");
    expect((receipt as { id: string }).id).toBe("rcpt_01J00000000000000000000000");
  });

  it("finds the transaction that issued a claim from its issue event", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 1,
                event: "issue",
                time: "2026-11-08T22:39:00Z",
                tx_hash: "ISSUETX",
                token_id: "c-9",
                data: {},
              },
              {
                id: 2,
                event: "booked",
                time: "2026-11-09T01:11:00Z",
                tx_hash: "BOOKTX",
                token_id: "c-9",
                data: {},
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const indexer = createHttpIndexer("http://indexer.test", fetchImpl);
    expect(await indexer.issueTx?.("c-9")).toBe("ISSUETX");
  });

  it("builds the receipt list from booked events and /r", async () => {
    const fetchImpl = fakeFetch();
    const indexer = createHttpIndexer("http://indexer.test", fetchImpl);
    const receipts = await indexer.listReceipts("acme.near", "c-1");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.booking_tx).toBe(
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    );
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://indexer.test/events?token_id=c-1&limit=200",
      "http://indexer.test/r/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    ]);
  });
});
