import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { HttpEventSink, type FetchLike } from "./webhook.js";
import type { ParsedEvent } from "./types.js";

const EVENT: ParsedEvent = {
  eventKey: "TxPay1:R1:0:0:0",
  blockHeight: 101,
  blockHash: "BlockHash101",
  blockTimestamp: 1793613660,
  txHash: "TxPay1",
  receiptId: "R1",
  logIndex: 0,
  dataIndex: 0,
  standard: "openrail",
  version: "1.0.0",
  event: "booked",
  tokenId: "c-1",
  data: { token_id: "c-1", payment: "12500000" },
  raw: "",
};

describe("indexer webhook sink", () => {
  it("posts only the indexed event with an HMAC signature", async () => {
    let body = "";
    let signature = "";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      signature = String((init?.headers as Record<string, string>)["x-openrail-signature"]);
      return new Response("{}", { status: 200 });
    }) as FetchLike;
    const sink = new HttpEventSink("https://api.test/hook", "secret", fetchImpl);

    await sink.emit(EVENT);

    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      type: "booked",
      token_id: "c-1",
      block_height: 101,
      tx_hash: "TxPay1",
    });
    expect(signature).toBe(`sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`);
  });

  it("throws on a non-2xx response so the caller can log it", async () => {
    const sink = new HttpEventSink(
      "https://api.test/hook",
      "",
      (async () => new Response("no", { status: 503 })) as FetchLike,
    );
    await expect(sink.emit(EVENT)).rejects.toThrow("WEBHOOK_HTTP_503");
  });
});
