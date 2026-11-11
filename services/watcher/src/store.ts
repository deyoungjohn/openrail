/** Small SQLite state so a watcher restart does not re-read every claim. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ClaimView } from "./types.js";

export interface StoredClaim {
  token_id: string;
  kind: number;
  status: string;
  last_quote_at: number | null;
  due_at: number;
  last_view: ClaimView;
  decided: boolean;
}

export class WatcherStore {
  private readonly db: DatabaseSync;
  private failures = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const open = (file: string): DatabaseSync => {
      const db = new DatabaseSync(file);
      db.exec(`
        CREATE TABLE IF NOT EXISTS watched_claims (
          token_id TEXT PRIMARY KEY,
          kind INTEGER NOT NULL,
          status TEXT NOT NULL,
          last_quote_at INTEGER,
          due_at INTEGER NOT NULL,
          last_view TEXT NOT NULL,
          decided INTEGER NOT NULL DEFAULT 0
        );
      `);
      return db;
    };
    try {
      this.db = open(path);
    } catch {
      // A corrupt file starts empty rather than stopping the watcher.
      this.db = open(":memory:");
    }
  }

  load(): StoredClaim[] {
    return this.db
      .prepare(
        "SELECT token_id, kind, status, last_quote_at, due_at, last_view, decided FROM watched_claims",
      )
      .all()
      .map((row) => ({
        token_id: String(row.token_id),
        kind: Number(row.kind),
        status: String(row.status),
        last_quote_at: row.last_quote_at === null ? null : Number(row.last_quote_at),
        due_at: Number(row.due_at),
        last_view: JSON.parse(String(row.last_view)) as ClaimView,
        decided: Number(row.decided) === 1,
      }));
  }

  /** One transaction per tick; a failing write is counted, never thrown into the tick. */
  save(rows: readonly StoredClaim[]): void {
    if (rows.length === 0) return;
    this.db.exec("BEGIN");
    try {
      const statement = this.db.prepare(
        "INSERT INTO watched_claims (token_id, kind, status, last_quote_at, due_at, last_view, decided) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(token_id) DO UPDATE SET kind=excluded.kind, status=excluded.status, last_quote_at=excluded.last_quote_at, due_at=excluded.due_at, last_view=excluded.last_view, decided=excluded.decided",
      );
      for (const row of rows) {
        statement.run(
          row.token_id,
          row.kind,
          row.status,
          row.last_quote_at,
          row.due_at,
          JSON.stringify(row.last_view),
          row.decided ? 1 : 0,
        );
      }
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      this.failures += 1;
    }
  }

  writeFailures(): number {
    return this.failures;
  }

  close(): void {
    this.db.close();
  }
}
