import { describe, expect, it } from "vitest";
import { createIndexerApp } from "./http.js";
import { Indexer } from "./indexer.js";
import {
  FakeClaimReader,
  FakeEnricher,
  FakeSource,
  ROOT,
  loadBlocks,
  memoryStore,
  silentLogger,
} from "./test-support.js";
import type { ClaimViewTotals } from "./types.js";

const CLAIM: ClaimViewTotals = {
  token_id: "c-1",
  amount_due: "12500000",
  booked_total: "12500000",
  distributed_total: "12468750",
  fee_total: "31250",
  surplus: "0",
  credit_total: "0",
  status: "Paid",
  terms_hash: "0x" + "aa".repeat(32),
  due_date: 1_800_000_000,
};

async function setup() {
  const store = memoryStore();
  const indexer = new Indexer({
    source: new FakeSource(loadBlocks()),
    store,
    enricher: new FakeEnricher(),
    maxPagesPerSync: 10,
    logger: silentLogger(),
  });
  await indexer.syncOnce();
  const app = createIndexerApp({
    store,
    indexer,
    claimReader: new FakeClaimReader({ "c-1": CLAIM }),
    rootAccount: ROOT,
  });
  return { store, indexer, app };
}

describe("indexer HTTP", () => {
  it("serves health with the cursor and last final head", async () => {
    const { app } = await setup();
    const response = await app.handle("GET", "/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      cursor: { height: 103, blockHash: "BlockHash103" },
      last_head: 103,
      events: 10,
      claims: 1,
    });
  });

  it("pokes the poller", async () => {
    const { app, indexer } = await setup();
    const before = indexer.health().boost_until;
    const response = await app.handle("POST", "/poke");
    expect(response.status).toBe(200);
    expect((response.body as { ok: boolean }).ok).toBe(true);
    expect(indexer.health().boost_until).toBeGreaterThan(before);
  });

  it("registers a transaction hash through the injected reader", async () => {
    const { store, indexer } = await setup();
    const app = createIndexerApp({
      store,
      indexer,
      rootAccount: ROOT,
      registerTx: async (hash, signer) => ({
        accepted: hash === "tx-1" && signer === "signer.near",
        events: 2,
      }),
    });
    const accepted = await app.handle("POST", "/register-tx", {
      hash: "tx-1",
      signer: "signer.near",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ accepted: true, events: 2 });
    const rejected = await app.handle("POST", "/register-tx", {
      hash: "tx-2",
      signer: "signer.near",
    });
    expect(rejected.status).toBe(400);
    const invalid = await app.handle("POST", "/register-tx", { hash: "tx-1" });
    expect(invalid.status).toBe(400);
  });

  it("serves paginated history for a claim", async () => {
    const { app } = await setup();
    const response = await app.handle("GET", "/history?token_id=c-1&limit=3");
    expect(response.status).toBe(200);
    const body = response.body as { data: unknown[]; next_cursor: number };
    expect(body.data).toHaveLength(3);
    expect(typeof body.next_cursor).toBe("number");
    expect((body.data[0] as { event: string }).event).toBe("issue");
  });

  it("serves only indexed events", async () => {
    const { app } = await setup();
    const response = await app.handle("GET", "/events?after=0&limit=200");
    const body = response.body as { data: { event: string }[] };
    expect(body.data).toHaveLength(10);
    expect(body.data.some((event) => event.event === "ft_transfer")).toBe(false);
  });

  it("renders a receipt only from the booked transaction", async () => {
    const { app } = await setup();
    const receipt = await app.handle("GET", "/r/TxPay1");
    expect(receipt.status).toBe(200);
    const body = receipt.body as {
      receipt: {
        amount: string;
        asset: string;
        claim_number: string;
        terms_hash: string;
        payment_instruction_v1: string;
        origin_tx: { hash: string };
        near_tx_hashes: string[];
        verified: boolean;
      };
      claim_account: string;
    };
    expect(body.receipt.amount).toBe("12500000");
    expect(body.receipt.asset).toContain("nep141:");
    expect(body.receipt.claim_number).toBe("c-1");
    expect(body.receipt.terms_hash).toBe("0x" + "aa".repeat(32));
    expect(body.receipt.payment_instruction_v1).toContain("Payment of any amount");
    expect(body.receipt.origin_tx.hash).toBe("0x" + "cc".repeat(32));
    expect(body.receipt.near_tx_hashes).toHaveLength(2);
    expect(body.receipt.verified).toBe(true);
    expect(body.claim_account).toBe("c-1.openrail.near");

    const missing = await app.handle("GET", "/r/TxIssue1");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: "receipt_not_found" } });
  });

  it("serves a CSV statement that reconciles with claim()", async () => {
    const { app } = await setup();
    const response = await app.handle(
      "GET",
      "/statements?token_id=c-1&from=2026-11-01&to=2026-11-30&format=csv",
    );
    expect(response.status).toBe(200);
    const body = response.body as { format: string; content_base64: string };
    expect(body.format).toBe("csv");
    const csv = Buffer.from(body.content_base64, "base64").toString("utf8");
    expect(csv).toContain("c-1");
    expect(csv.trim().endsWith("true")).toBe(true);
  });

  it("returns 405/404 for unsupported requests", async () => {
    const { app } = await setup();
    expect((await app.handle("POST", "/health")).status).toBe(405);
    expect((await app.handle("GET", "/nope")).status).toBe(404);
  });
});
