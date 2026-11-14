import { describe, expect, it } from "vitest";
import { hasIndexedEvent } from "../checkout-events.js";

interface Row {
  id: number;
  event: string;
  token_id: string;
  data: { token_id: string };
}

/** Same contract as services/indexer/src/http.ts: oldest first, `after` cursor, `token_id` filter. */
function indexer(rows: () => Row[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const token = url.searchParams.get("token_id");
    const after = Number(url.searchParams.get("after") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const page = rows()
      .filter((r) => (token === null || r.token_id === token) && r.id > after)
      .slice(0, limit);
    return new Response(JSON.stringify({ data: page, next_cursor: page.at(-1)?.id ?? null }));
  }) as typeof fetch;
}

const noWait = async () => undefined;

describe("hasIndexedEvent", () => {
  it("finds the event even when 200 older events fill the first page", async () => {
    const rows: Row[] = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      event: "payment_booked",
      token_id: "other",
      data: { token_id: "other" },
    }));
    rows.push({ id: 251, event: "checkout_paid", token_id: "c-1", data: { token_id: "c-1" } });
    const ok = await hasIndexedEvent(
      { indexer: "http://i", fetchImpl: indexer(() => rows), sleep: noWait },
      "c-1",
      "checkout_paid",
    );
    expect(ok).toBe(true);
  });

  it("waits for the indexer to catch up", async () => {
    const rows: Row[] = [];
    let calls = 0;
    const base = indexer(() => rows);
    const fetchImpl = (async (input: string | URL | Request) => {
      calls += 1;
      if (calls === 3)
        rows.push({ id: 1, event: "checkout_paid", token_id: "c-2", data: { token_id: "c-2" } });
      return base(input);
    }) as typeof fetch;
    const ok = await hasIndexedEvent(
      { indexer: "http://i", fetchImpl, sleep: noWait },
      "c-2",
      "checkout_paid",
    );
    expect(ok).toBe(true);
  });

  it("is false for another token or another event, and after the attempts run out", async () => {
    const rows: Row[] = [
      { id: 1, event: "checkout_paid", token_id: "c-3", data: { token_id: "c-3" } },
    ];
    const ctx = { indexer: "http://i", fetchImpl: indexer(() => rows), sleep: noWait, attempts: 2 };
    expect(await hasIndexedEvent(ctx, "c-4", "checkout_paid")).toBe(false);
    expect(await hasIndexedEvent(ctx, "c-3", "payment_booked")).toBe(false);
  });
});
