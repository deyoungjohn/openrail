/**
 * Looks for one indexed event of a checkout.
 *
 * The indexer lists events oldest first (`ORDER BY id`, `after` cursor). A query without
 * `token_id` returns only the first page of the whole history, so on a busy indexer the new
 * event is never in it. Always ask for the token, follow the cursor, and wait for the indexer
 * to catch up (it trails the chain by a few blocks).
 */
export interface EventLookup {
  indexer: string;
  fetchImpl: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

export async function hasIndexedEvent(
  ctx: EventLookup,
  tokenId: string,
  eventName: string,
): Promise<boolean> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const attempts = ctx.attempts ?? 15;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let after = 0;
    for (let pages = 0; pages < 20; pages += 1) {
      const url = `${ctx.indexer}/events?token_id=${encodeURIComponent(tokenId)}&after=${after}&limit=200`;
      const body = (await ctx
        .fetchImpl(url)
        .then((r) => r.json())
        .catch(() => ({}))) as { data?: unknown; next_cursor?: unknown };
      const list = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
      const found = list.some((entry) => {
        const type = String(entry.event ?? entry.type ?? "");
        const data = (entry.data ?? {}) as Record<string, unknown>;
        return type === eventName && (data.token_id ?? entry.token_id) === tokenId;
      });
      if (found) return true;
      if (list.length === 0 || typeof body.next_cursor !== "number") break;
      after = body.next_cursor;
    }
    if (attempt + 1 < attempts) await sleep(ctx.intervalMs ?? 2_000);
  }
  return false;
}
