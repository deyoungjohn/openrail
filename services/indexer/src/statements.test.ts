import { describe, expect, it } from "vitest";
import { buildStatement, renderCsv, statementRows } from "./statements.js";
import {
  FakeClaimReader,
  FakeSource,
  loadBlocks,
  memoryStore,
  silentLogger,
  ROOT,
} from "./test-support.js";
import { Indexer } from "./indexer.js";
import type { ClaimViewTotals } from "./types.js";

const MATCHING: ClaimViewTotals = {
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

async function syncedStore() {
  const store = memoryStore();
  const indexer = new Indexer({
    source: new FakeSource(loadBlocks()),
    store,
    maxPagesPerSync: 10,
    logger: silentLogger(),
  });
  await indexer.syncOnce();
  return store;
}

describe("indexer statements", () => {
  it("builds a per-claim CSV that reconciles with claim()", async () => {
    const store = await syncedStore();
    const reader = new FakeClaimReader({ "c-1": MATCHING });
    const envelope = await buildStatement(
      store,
      { from: "2026-11-01", to: "2026-11-30", tokenId: "c-1", format: "csv" },
      reader,
      new Date("2026-11-02T10:10:00Z"),
    );
    expect(envelope.format).toBe("csv");
    expect(envelope.filename).toBe("statement-c-1-2026-11-01-2026-11-30.csv");
    expect(envelope.content_type).toBe("text/csv");
    const csv = Buffer.from(envelope.content_base64, "base64").toString("utf8");
    expect(csv.split("\n")[0]).toContain("token_id,invoice_number,amount_due");
    expect(csv).toContain("c-1,c-1,12500000,12500000,31250,12468750,0,0,Paid");
    expect(csv.trim().endsWith("true")).toBe(true);
    expect(envelope.sha256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("marks a mismatch with claim() instead of hiding it", async () => {
    const store = await syncedStore();
    const reader = new FakeClaimReader({
      "c-1": { ...MATCHING, booked_total: "999" },
    });
    const rows = await statementRows(
      store,
      { from: "2026-11-01", to: "2026-11-30", tokenId: "c-1", format: "csv" },
      reader,
    );
    expect(rows[0]?.reconciles).toBe(false);
    expect(renderCsv(rows).trim().endsWith("false")).toBe(true);
  });

  it("builds a period statement and a PDF envelope", async () => {
    const store = await syncedStore();
    const period = await buildStatement(
      store,
      { from: "2026-11-01", to: "2026-11-30", format: "csv" },
      new FakeClaimReader({ "c-1": MATCHING }),
    );
    const periodCsv = Buffer.from(period.content_base64, "base64").toString("utf8");
    expect(periodCsv).toContain("c-1");

    const pdf = await buildStatement(
      store,
      { from: "2026-11-01", to: "2026-11-30", tokenId: "c-1", format: "pdf" },
      new FakeClaimReader({ "c-1": MATCHING }),
    );
    expect(pdf.content_type).toBe("application/pdf");
    const bytes = Buffer.from(pdf.content_base64, "base64");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("OPENRAIL STATEMENT");
    expect(bytes.toString("latin1")).toContain("c-1");
    expect(pdf.sha256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects an invalid period", async () => {
    const store = await syncedStore();
    await expect(
      buildStatement(store, { from: "2026-11-30", to: "2026-11-01", format: "csv" }),
    ).rejects.toThrow("INVALID_RANGE");
    await expect(
      buildStatement(store, { from: "not-a-date", to: "2026-11-01", format: "csv" }),
    ).rejects.toThrow("INVALID_DATE");
  });

  it("includes all claims when no token id is given", async () => {
    const store = await syncedStore();
    const rows = await statementRows(store, {
      from: "2026-11-01",
      to: "2026-11-30",
      format: "csv",
    });
    expect(rows.map((row) => row.token_id)).toEqual(["c-1"]);
    expect(rows[0]?.invoice_number).toBe("c-1");
    expect(ROOT).toBe("openrail.near");
  });
});
