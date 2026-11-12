/** Compares the watcher's cached claim totals with the rows this indexer holds. */
import { DatabaseSync } from "node:sqlite";
import type { IndexerStore } from "./store.js";

export interface Gap {
  token_id: string;
  expected: string;
  seen: string;
  age_seconds: number;
}

interface CachedClaim {
  token_id: string;
  last_quote_at: number | null;
  last_view: string;
}

export class WatcherViews {
  constructor(private readonly path: string | undefined) {}

  cached(): CachedClaim[] {
    if (this.path === undefined) return [];
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
      return db
        .prepare("SELECT token_id, last_quote_at, last_view FROM watched_claims")
        .all() as unknown as CachedClaim[];
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  gaps(store: IndexerStore, nowMs: number, fromSeconds: number, since: Map<string, number>): Gap[] {
    const gaps: Gap[] = [];
    for (const claim of this.cached()) {
      if (fromSeconds > 0 && (claim.last_quote_at ?? 0) < fromSeconds) continue;
      let view: { booked_total?: unknown };
      try {
        view = JSON.parse(claim.last_view) as { booked_total?: unknown };
      } catch {
        continue;
      }
      const expected = BigInt(
        typeof view.booked_total === "string" || typeof view.booked_total === "number"
          ? view.booked_total
          : "0",
      );
      const seen = store.bookedTotal(claim.token_id);
      if (expected <= seen) {
        since.delete(claim.token_id);
        continue;
      }
      const first = since.get(claim.token_id) ?? nowMs;
      since.set(claim.token_id, first);
      gaps.push({
        token_id: claim.token_id,
        expected: expected.toString(),
        seen: seen.toString(),
        age_seconds: Math.max(0, Math.floor((nowMs - first) / 1000)),
      });
    }
    return gaps;
  }
}
