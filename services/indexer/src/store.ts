/**
 * SQLite store for indexed NEP-297 events (blueprint 2.9). `node:sqlite`, no ORM.
 * The event key makes ingestion idempotent; the cursor makes it resumable; the receipt row is
 * created only by a `booked` event (receipt_equals_booked_event).
 */
import { DatabaseSync } from "node:sqlite";
import { parseBlock, PRUNABLE_EVENTS } from "./parse.js";
import type { ParsedEvent, ReceiptEvidence, SourceBlock } from "./types.js";

interface LegShape {
  receiver?: unknown;
  asset?: unknown;
  amount?: unknown;
}

function payLeg(leg: unknown): LegShape | null {
  if (leg === null || typeof leg !== "object") return null;
  const value = (leg as { Pay?: unknown }).Pay;
  if (value === null || typeof value !== "object") return null;
  return value as LegShape;
}

export interface Cursor {
  height: number;
  blockHash: string;
  sourceCursor: string | null;
}

export interface EventRow {
  id: number;
  event_key: string;
  block_height: number;
  block_hash: string;
  block_timestamp: number;
  tx_hash: string;
  event: string;
  token_id: string | null;
  data_json: string;
}

export interface ReceiptRow {
  id: number;
  tx_hash: string;
  token_id: string;
  payment: string;
  surplus: string;
  fee: string;
  credit: string;
  asset: string;
  timestamp: number;
  block_height: number;
  terms_hash: string;
  legs_json: string;
  origin_json: string | null;
  near_hashes_json: string | null;
  verified: number;
}

export interface BookingRow {
  id: number;
  event_key: string;
  token_id: string;
  tx_hash: string;
  payment: string;
  asset: string;
  block_timestamp: number;
}

export interface StatementSourceRow {
  token_id: string;
  owner_id: string | null;
  issuer_id: string | null;
  claim_account: string | null;
  amount_due: string;
  due_date: number;
  terms_hash: string;
  status: string;
  booked_total: bigint;
  distributed_total: bigint;
  fee_total: bigint;
  surplus: bigint;
  credit_total: bigint;
  bookings: number;
}

const SCHEMA_VERSION = 1;

export class IndexerStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly rootAccount: string,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        height INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        source_cursor TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        block_height INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        block_timestamp INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        standard TEXT NOT NULL,
        version TEXT NOT NULL,
        event TEXT NOT NULL,
        token_id TEXT,
        data_json TEXT NOT NULL,
        raw TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_token ON events(token_id, id);
      CREATE TABLE IF NOT EXISTS claims (
        token_id TEXT PRIMARY KEY,
        owner_id TEXT,
        issuer_id TEXT,
        claim_account TEXT,
        kind INTEGER,
        terms_hash TEXT,
        amount_due TEXT NOT NULL DEFAULT '0',
        due_date INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Issued',
        created_block INTEGER NOT NULL DEFAULT 0,
        updated_block INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        token_id TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        payment TEXT NOT NULL,
        surplus TEXT NOT NULL,
        fee TEXT NOT NULL,
        credit TEXT NOT NULL,
        legs_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bookings_token_time ON bookings(token_id, timestamp);
      CREATE TABLE IF NOT EXISTS legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL,
        token_id TEXT NOT NULL,
        receiver TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS legs_booking ON legs(booking_id);
      CREATE TABLE IF NOT EXISTS quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        token_id TEXT NOT NULL,
        quote_id TEXT NOT NULL,
        deposit_address TEXT NOT NULL,
        deadline_requested INTEGER NOT NULL,
        refund_to TEXT NOT NULL,
        route_id TEXT NOT NULL,
        block_height INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS quotes_token ON quotes(token_id, id);
      CREATE TABLE IF NOT EXISTS acks (
        token_id TEXT PRIMARY KEY,
        scheme_json TEXT NOT NULL,
        block INTEGER NOT NULL,
        event_key TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        token_id TEXT NOT NULL,
        old_owner_id TEXT,
        new_owner_id TEXT,
        authorized_id TEXT,
        memo TEXT,
        block_height INTEGER NOT NULL,
        tx_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        tx_hash TEXT NOT NULL,
        token_id TEXT NOT NULL,
        payment TEXT NOT NULL,
        surplus TEXT NOT NULL,
        fee TEXT NOT NULL,
        credit TEXT NOT NULL,
        asset TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        block_height INTEGER NOT NULL,
        terms_hash TEXT NOT NULL,
        legs_json TEXT NOT NULL,
        origin_json TEXT,
        near_hashes_json TEXT,
        verified INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS receipts_tx ON receipts(tx_hash);
      CREATE TABLE IF NOT EXISTS budget_state (
        day TEXT PRIMARY KEY,
        used INTEGER NOT NULL
      );
    `);
    const cursorColumns = this.db.prepare("PRAGMA table_info(cursor)").all() as unknown as {
      name: string;
    }[];
    if (!cursorColumns.some((column) => column.name === "source_cursor")) {
      this.db.exec("ALTER TABLE cursor ADD COLUMN source_cursor TEXT");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(SCHEMA_VERSION, new Date().toISOString());
    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(SCHEMA_VERSION + 1, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  cursor(): Cursor | null {
    const row = this.db
      .prepare("SELECT height, block_hash, source_cursor FROM cursor WHERE id = 1")
      .get() as { height: number; block_hash: string; source_cursor: string | null } | undefined;
    return row === undefined
      ? null
      : {
          height: row.height,
          blockHash: row.block_hash,
          sourceCursor: row.source_cursor,
        };
  }

  /** Stores the account-scoped source cursor and the highest processed block. */
  setCursor(height: number, blockHash: string, sourceCursor: string | null): void {
    this.db
      .prepare(
        "INSERT INTO cursor(id, height, block_hash, source_cursor, updated_at) VALUES (1, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET height=excluded.height, block_hash=excluded.block_hash, source_cursor=excluded.source_cursor, updated_at=excluded.updated_at",
      )
      .run(height, blockHash, sourceCursor, new Date().toISOString());
  }

  private insertEvent(event: ParsedEvent): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO events(event_key, block_height, block_hash, block_timestamp, tx_hash, receipt_id, standard, version, event, token_id, data_json, raw) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventKey,
        event.blockHeight,
        event.blockHash,
        event.blockTimestamp,
        event.txHash,
        event.receiptId,
        event.standard,
        event.version,
        event.event,
        event.tokenId,
        JSON.stringify(event.data),
        event.raw,
      );
    return result.changes > 0;
  }

  private upsertClaim(event: ParsedEvent, status?: string): void {
    if (event.tokenId === null) return;
    const data = event.data;
    const amountDue = typeof data.amount_due === "string" ? data.amount_due : "0";
    this.db
      .prepare(
        "INSERT INTO claims(token_id, owner_id, issuer_id, claim_account, kind, terms_hash, amount_due, due_date, status, created_block, updated_block) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(token_id) DO UPDATE SET " +
          "owner_id=COALESCE(excluded.owner_id, claims.owner_id), " +
          "issuer_id=COALESCE(excluded.issuer_id, claims.issuer_id), " +
          "claim_account=COALESCE(excluded.claim_account, claims.claim_account), " +
          "kind=COALESCE(excluded.kind, claims.kind), " +
          "terms_hash=COALESCE(excluded.terms_hash, claims.terms_hash), " +
          "amount_due=CASE WHEN excluded.amount_due='0' THEN claims.amount_due ELSE excluded.amount_due END, " +
          "due_date=CASE WHEN excluded.due_date=0 THEN claims.due_date ELSE excluded.due_date END, " +
          "status=COALESCE(excluded.status, claims.status), " +
          "updated_block=excluded.updated_block",
      )
      .run(
        event.tokenId,
        typeof data.owner_id === "string" ? data.owner_id : null,
        typeof data.issuer_id === "string" ? data.issuer_id : null,
        `${event.tokenId}.${this.rootAccount}`,
        typeof data.kind === "number" ? data.kind : null,
        typeof data.terms_hash === "string" ? data.terms_hash : null,
        amountDue,
        typeof data.due_date === "number" ? data.due_date : 0,
        status ?? "Issued",
        event.blockHeight,
        event.blockHeight,
      );
  }

  private insertBooking(event: ParsedEvent): void {
    if (event.tokenId === null) return;
    const data = event.data;
    const payment = typeof data.payment === "string" ? data.payment : "0";
    const surplus = typeof data.surplus === "string" ? data.surplus : "0";
    const fee = typeof data.fee === "string" ? data.fee : "0";
    const credit = typeof data.credit === "string" ? data.credit : "0";
    const legs = Array.isArray(data.legs) ? data.legs : [];
    const insert = this.db
      .prepare(
        "INSERT INTO bookings(event_key, token_id, tx_hash, block_height, timestamp, payment, surplus, fee, credit, legs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventKey,
        event.tokenId,
        event.txHash,
        event.blockHeight,
        event.blockTimestamp,
        payment,
        surplus,
        fee,
        credit,
        JSON.stringify(legs),
      );
    const bookingId = Number(insert.lastInsertRowid);
    for (const leg of legs) {
      const pay = payLeg(leg);
      if (pay === null) continue;
      this.db
        .prepare(
          "INSERT INTO legs(booking_id, token_id, receiver, asset, amount, status) VALUES (?, ?, ?, ?, ?, 'booked')",
        )
        .run(
          bookingId,
          event.tokenId,
          typeof pay.receiver === "string" ? pay.receiver : "",
          typeof pay.asset === "string" ? pay.asset : "",
          typeof pay.amount === "string" ? pay.amount : "0",
        );
    }
    const firstPay = legs.map(payLeg).find((leg): leg is LegShape => leg !== null);
    const asset = typeof firstPay?.asset === "string" ? firstPay.asset : "";
    const claim = this.db
      .prepare("SELECT terms_hash FROM claims WHERE token_id = ?")
      .get(event.tokenId) as { terms_hash: string | null } | undefined;
    this.db
      .prepare(
        "INSERT INTO receipts(event_key, tx_hash, token_id, payment, surplus, fee, credit, asset, timestamp, block_height, terms_hash, legs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventKey,
        event.txHash,
        event.tokenId,
        payment,
        surplus,
        fee,
        credit,
        asset,
        event.blockTimestamp,
        event.blockHeight,
        claim?.terms_hash ?? "",
        JSON.stringify(legs),
      );
  }

  private applyEvent(event: ParsedEvent): void {
    if (event.standard === "nep171") {
      if (event.tokenId === null) return;
      if (event.event === "nft_mint") {
        this.upsertClaim(event, "Issued");
      } else if (event.event === "nft_transfer") {
        const oldOwner = event.data.old_owner_id;
        const newOwner = event.data.new_owner_id;
        this.db
          .prepare(
            "INSERT INTO transfers(event_key, token_id, old_owner_id, new_owner_id, authorized_id, memo, block_height, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            event.eventKey,
            event.tokenId,
            typeof oldOwner === "string" ? oldOwner : null,
            typeof newOwner === "string" ? newOwner : null,
            typeof event.data.authorized_id === "string" ? event.data.authorized_id : null,
            typeof event.data.memo === "string" ? event.data.memo : null,
            event.blockHeight,
            event.txHash,
          );
        if (typeof newOwner === "string") {
          this.db
            .prepare(
              "INSERT INTO claims(token_id, owner_id, status, created_block, updated_block) VALUES (?, ?, 'Issued', ?, ?) " +
                "ON CONFLICT(token_id) DO UPDATE SET owner_id=excluded.owner_id, updated_block=excluded.updated_block",
            )
            .run(event.tokenId, newOwner, event.blockHeight, event.blockHeight);
        }
      }
      return;
    }

    switch (event.event) {
      case "issue":
        this.upsertClaim(event, "Issued");
        break;
      case "ack":
        if (event.tokenId !== null) {
          this.db
            .prepare(
              "INSERT OR REPLACE INTO acks(token_id, scheme_json, block, event_key) VALUES (?, ?, ?, ?)",
            )
            .run(
              event.tokenId,
              JSON.stringify(event.data.scheme ?? null),
              typeof event.data.block === "number" ? event.data.block : event.blockHeight,
              event.eventKey,
            );
        }
        break;
      case "quote_logged":
        if (event.tokenId !== null) {
          this.db
            .prepare(
              "INSERT INTO quotes(event_key, token_id, quote_id, deposit_address, deadline_requested, refund_to, route_id, block_height) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              event.eventKey,
              event.tokenId,
              typeof event.data.quote_id === "string" ? event.data.quote_id : "",
              typeof event.data.deposit_address === "string" ? event.data.deposit_address : "",
              typeof event.data.deadline_requested === "number" ? event.data.deadline_requested : 0,
              typeof event.data.refund_to === "string" ? event.data.refund_to : "",
              typeof event.data.route_id === "string" ? event.data.route_id : "",
              event.blockHeight,
            );
        }
        break;
      case "booked":
        this.insertBooking(event);
        break;
      case "distributed":
      case "distribution_failed": {
        if (event.tokenId === null) break;
        const leg = payLeg(event.data.leg);
        if (leg === null) break;
        const status = event.event === "distributed" ? "distributed" : "failed";
        this.db
          .prepare(
            "UPDATE legs SET status = ? WHERE id = (" +
              "SELECT id FROM legs WHERE token_id = ? AND receiver = ? AND asset = ? AND amount = ? AND status = 'booked' ORDER BY id LIMIT 1)",
          )
          .run(
            status,
            event.tokenId,
            typeof leg.receiver === "string" ? leg.receiver : "",
            typeof leg.asset === "string" ? leg.asset : "",
            typeof leg.amount === "string" ? leg.amount : "0",
          );
        break;
      }
      case "cancel":
        if (event.tokenId !== null)
          this.setClaimStatus(event.tokenId, "Cancelled", event.blockHeight);
        break;
      case "close":
      case "writeoff":
        if (event.tokenId !== null) this.setClaimStatus(event.tokenId, "Closed", event.blockHeight);
        break;
      default:
        break;
    }
  }

  private setClaimStatus(tokenId: string, status: string, block: number): void {
    this.db
      .prepare("UPDATE claims SET status = ?, updated_block = ? WHERE token_id = ?")
      .run(status, block, tokenId);
  }

  /** Ingests one final block atomically and returns the newly inserted events. */
  ingestBlock(block: SourceBlock): ParsedEvent[] {
    const inserted: ParsedEvent[] = [];
    this.db.exec("BEGIN");
    try {
      for (const event of parseBlock(block)) {
        if (!this.insertEvent(event)) continue;
        this.applyEvent(event);
        inserted.push(event);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return inserted;
  }

  eventsAfter(afterId: number, limit: number, tokenId?: string): EventRow[] {
    const rows = (tokenId === undefined
      ? this.db
          .prepare(
            "SELECT id, event_key, block_height, block_hash, block_timestamp, tx_hash, event, token_id, data_json FROM events WHERE id > ? ORDER BY id LIMIT ?",
          )
          .all(afterId, limit)
      : this.db
          .prepare(
            "SELECT id, event_key, block_height, block_hash, block_timestamp, tx_hash, event, token_id, data_json FROM events WHERE token_id = ? AND id > ? ORDER BY id LIMIT ?",
          )
          .all(tokenId, afterId, limit)) as unknown as EventRow[];
    return rows;
  }

  receipt(txHash: string): ReceiptRow | null {
    const row = this.db
      .prepare("SELECT * FROM receipts WHERE tx_hash = ? ORDER BY id LIMIT 1")
      .get(txHash) as ReceiptRow | undefined;
    return row ?? null;
  }

  latestQuote(tokenId: string): { depositAddress: string; routeId: string } | null {
    const row = this.db
      .prepare(
        "SELECT deposit_address, route_id FROM quotes WHERE token_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(tokenId) as { deposit_address: string; route_id: string } | undefined;
    return row === undefined
      ? null
      : { depositAddress: row.deposit_address, routeId: row.route_id };
  }

  bookingByEventKey(eventKey: string): BookingRow | null {
    const row = this.db
      .prepare(
        "SELECT id, event_key, token_id, tx_hash, payment, timestamp FROM bookings WHERE event_key = ?",
      )
      .get(eventKey) as
      | {
          id: number;
          event_key: string;
          token_id: string;
          tx_hash: string;
          payment: string;
          timestamp: number;
        }
      | undefined;
    if (row === undefined) return null;
    const leg = this.db
      .prepare("SELECT asset FROM legs WHERE booking_id = ? ORDER BY id LIMIT 1")
      .get(row.id) as { asset: string } | undefined;
    return {
      id: row.id,
      event_key: row.event_key,
      token_id: row.token_id,
      tx_hash: row.tx_hash,
      payment: row.payment,
      asset: leg?.asset ?? "",
      block_timestamp: row.timestamp,
    };
  }

  updateReceiptEvidence(eventKey: string, evidence: ReceiptEvidence): void {
    this.db
      .prepare(
        "UPDATE receipts SET origin_json = ?, near_hashes_json = ?, verified = ? WHERE event_key = ?",
      )
      .run(
        evidence.origin_tx === null ? null : JSON.stringify(evidence.origin_tx),
        JSON.stringify(evidence.near_tx_hashes),
        evidence.verified ? 1 : 0,
        eventKey,
      );
  }

  /** Claims and their indexed totals in [fromTs, toTs); one claim when tokenId is given. */
  statementRows(fromTs: number, toTs: number, tokenId?: string): StatementSourceRow[] {
    const claims = (tokenId === undefined
      ? this.db
          .prepare(
            "SELECT token_id, owner_id, issuer_id, claim_account, amount_due, due_date, terms_hash, status, created_block FROM claims",
          )
          .all()
      : this.db
          .prepare(
            "SELECT token_id, owner_id, issuer_id, claim_account, amount_due, due_date, terms_hash, status, created_block FROM claims WHERE token_id = ?",
          )
          .all(tokenId)) as unknown as {
      token_id: string;
      owner_id: string | null;
      issuer_id: string | null;
      claim_account: string | null;
      amount_due: string;
      due_date: number;
      terms_hash: string;
      status: string;
      created_block: number;
    }[];

    return claims.map((claim) => {
      const bookings = this.db
        .prepare(
          "SELECT payment, surplus, fee, credit FROM bookings WHERE token_id = ? AND timestamp >= ? AND timestamp < ?",
        )
        .all(claim.token_id, fromTs, toTs) as unknown as {
        payment: string;
        surplus: string;
        fee: string;
        credit: string;
      }[];
      let booked = 0n;
      let fee = 0n;
      let surplus = 0n;
      let credit = 0n;
      let net = 0n;
      for (const booking of bookings) {
        const payment = BigInt(booking.payment);
        booked += payment + BigInt(booking.surplus) + BigInt(booking.credit);
        fee += BigInt(booking.fee);
        surplus += BigInt(booking.surplus);
        credit += BigInt(booking.credit);
        net += payment - BigInt(booking.fee);
      }
      const status =
        claim.status === "Cancelled" || claim.status === "Closed"
          ? claim.status
          : booked >= BigInt(claim.amount_due) && BigInt(claim.amount_due) > 0n
            ? "Paid"
            : booked > 0n
              ? "PartiallyPaid"
              : "Issued";
      return {
        token_id: claim.token_id,
        owner_id: claim.owner_id,
        issuer_id: claim.issuer_id,
        claim_account: claim.claim_account,
        amount_due: claim.amount_due,
        due_date: claim.due_date,
        terms_hash: claim.terms_hash,
        status,
        booked_total: booked,
        distributed_total: net,
        fee_total: fee,
        surplus,
        credit_total: credit,
        bookings: bookings.length,
      };
    });
  }

  /** Deletes prunable operational events older than the cutoff; evidence is never touched. */
  pruneTransient(cutoffTimestamp: number): number {
    const events = this.db
      .prepare("SELECT id, event FROM events WHERE block_timestamp < ?")
      .all(cutoffTimestamp) as unknown as { id: number; event: string }[];
    const toDelete = events
      .filter((event) => PRUNABLE_EVENTS.has(event.event))
      .map((event) => event.id);
    if (toDelete.length === 0) return 0;
    const statement = this.db.prepare("DELETE FROM events WHERE id = ?");
    this.db.exec("BEGIN");
    try {
      for (const id of toDelete) statement.run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return toDelete.length;
  }

  analytics(): {
    average_days_to_paid: number | null;
    paid_on_time_rate: number | null;
    payments_by_chain: { chain: string; count: number; amount: string }[];
    payments_by_asset: { asset: string; count: number; amount: string }[];
    sample: { claims: number; paid: number; on_time: number };
  } {
    const issueRows = this.db
      .prepare(
        "SELECT token_id, MIN(block_timestamp) AS issued_at FROM events WHERE event = 'issue' AND token_id IS NOT NULL GROUP BY token_id",
      )
      .all() as { token_id: string; issued_at: number }[];
    const dueRows = this.db.prepare("SELECT token_id, due_date, amount_due FROM claims").all() as {
      token_id: string;
      due_date: number;
      amount_due: string;
    }[];
    const receipts = this.db
      .prepare("SELECT token_id, payment, asset, timestamp, origin_json FROM receipts")
      .all() as {
      token_id: string;
      payment: string;
      asset: string;
      timestamp: number;
      origin_json: string | null;
    }[];
    const issued = new Map(issueRows.map((row) => [row.token_id, Number(row.issued_at)]));
    const due = new Map(dueRows.map((row) => [row.token_id, Number(row.due_date)]));
    const amountDue = new Map(dueRows.map((row) => [row.token_id, BigInt(row.amount_due)]));
    const receiptsByToken = new Map<string, { payment: bigint; timestamp: number }[]>();
    const chain = new Map<string, { count: number; amount: bigint }>();
    const asset = new Map<string, { count: number; amount: bigint }>();

    for (const row of receipts) {
      const list = receiptsByToken.get(row.token_id) ?? [];
      list.push({ payment: BigInt(row.payment), timestamp: Number(row.timestamp) });
      receiptsByToken.set(row.token_id, list);
      let chainName = "unknown";
      if (row.origin_json !== null) {
        try {
          const origin = JSON.parse(row.origin_json) as { chain?: unknown };
          if (typeof origin.chain === "string" && origin.chain !== "") chainName = origin.chain;
        } catch {
          // keep unknown
        }
      }
      const chainEntry = chain.get(chainName) ?? { count: 0, amount: 0n };
      chainEntry.count += 1;
      chainEntry.amount += BigInt(row.payment);
      chain.set(chainName, chainEntry);
      const assetEntry = asset.get(row.asset) ?? { count: 0, amount: 0n };
      assetEntry.count += 1;
      assetEntry.amount += BigInt(row.payment);
      asset.set(row.asset, assetEntry);
    }

    let totalDays = 0;
    let timed = 0;
    let onTime = 0;
    let paid = 0;
    for (const [tokenId, rows] of receiptsByToken) {
      const target = amountDue.get(tokenId) ?? 0n;
      if (target <= 0n) continue;
      const ordered = [...rows].sort((a, b) => a.timestamp - b.timestamp);
      let cumulative = 0n;
      let paidAt: number | null = null;
      for (const row of ordered) {
        cumulative += row.payment;
        if (cumulative >= target) {
          paidAt = row.timestamp;
          break;
        }
      }
      if (paidAt === null) continue;
      paid += 1;
      const issuedAt = issued.get(tokenId);
      if (issuedAt !== undefined) {
        totalDays += Math.max(0, paidAt - issuedAt) / 86_400;
        timed += 1;
      }
      const dueAt = due.get(tokenId) ?? 0;
      if (dueAt > 0 && paidAt <= dueAt) onTime += 1;
    }
    return {
      average_days_to_paid: timed === 0 ? null : totalDays / timed,
      paid_on_time_rate: paid === 0 ? null : onTime / paid,
      payments_by_chain: [...chain.entries()].map(([name, value]) => ({
        chain: name,
        count: value.count,
        amount: value.amount.toString(),
      })),
      payments_by_asset: [...asset.entries()].map(([name, value]) => ({
        asset: name,
        count: value.count,
        amount: value.amount.toString(),
      })),
      sample: { claims: issued.size, paid, on_time: onTime },
    };
  }

  budgetState(): { day: string; used: number } | null {
    const row = this.db
      .prepare("SELECT day, used FROM budget_state ORDER BY day DESC LIMIT 1")
      .get() as { day: string; used: number } | undefined;
    return row === undefined ? null : { day: row.day, used: Number(row.used) };
  }

  setBudgetState(day: string, used: number): void {
    this.db
      .prepare(
        "INSERT INTO budget_state(day, used) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET used=excluded.used",
      )
      .run(day, used);
  }

  health(): {
    cursor: Cursor | null;
    events: number;
    claims: number;
    bookings: number;
    quotes: number;
    acks: number;
    transfers: number;
  } {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return row.n;
    };
    return {
      cursor: this.cursor(),
      events: count("events"),
      claims: count("claims"),
      bookings: count("bookings"),
      quotes: count("quotes"),
      acks: count("acks"),
      transfers: count("transfers"),
    };
  }
}
