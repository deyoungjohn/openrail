/** Store interfaces plus in-memory and SQLite implementations. */
import { DatabaseSync } from "node:sqlite";
import type { InvoiceRecord, BusinessRecord } from "./app.js";
import type { Challenge, ApiKeyRecord } from "./auth.js";
import type { PaySession } from "./quote.js";
import type { WebhookEndpointRecord } from "./webhooks.js";
import type { StoredResponse } from "./idempotency.js";
import type { RecurringStore } from "./recurring.js";
import { createMemoryRecurringStore, createSqliteRecurringStore } from "./recurring-store.js";
import { createMemoryModuleStore, createSqliteModuleStore, type ModuleStore } from "./modules.js";

export interface OutboxRow {
  endpointId: string;
  eventId: string;
  event: string;
  attempt: number;
  nextAttemptAt: number;
  expiresAt: number;
  delivered: boolean;
}

export interface ApiStore {
  listInvoices(accountId?: string): InvoiceRecord[];
  getInvoice(idOrToken: string): InvoiceRecord | undefined;
  saveInvoice(record: InvoiceRecord): void;
  listPayments(accountId?: string): Record<string, unknown>[];
  getPayment(id: string): Record<string, unknown> | undefined;
  savePayment(id: string, body: Record<string, unknown>): void;
  getReceipt(idOrHash: string): Record<string, unknown> | undefined;
  listReceipts(tokenId: string): Record<string, unknown>[];
  saveReceipt(
    id: string,
    tokenId: string,
    bookingHash: string,
    body: Record<string, unknown>,
  ): void;
  listWebhookEndpoints(accountId?: string): WebhookEndpointRecord[];
  getWebhookEndpoint(id: string): WebhookEndpointRecord | undefined;
  saveWebhookEndpoint(accountId: string, endpoint: WebhookEndpointRecord): void;
  deleteWebhookEndpoint(id: string): void;
  addDelivery(endpointId: string, delivery: Record<string, unknown>): void;
  listDeliveries(endpointId: string): Record<string, unknown>[];
  outboxEnqueue(
    endpointId: string,
    eventId: string,
    event: string,
    nextAttemptAt: number,
    expiresAt: number,
  ): boolean;
  outboxDue(now: number): OutboxRow[];
  outboxMarkDelivered(endpointId: string, eventId: string): void;
  outboxReschedule(
    endpointId: string,
    eventId: string,
    attempt: number,
    nextAttemptAt: number,
  ): void;
  outboxExpire(endpointId: string, eventId: string): void;
  getPaySession(id: string): PaySession | undefined;
  savePaySession(session: PaySession): void;
  getOpenQuotes(tokenId: string): Record<string, unknown>[];
  saveOpenQuotes(tokenId: string, quotes: Record<string, unknown>[]): void;
  getBusiness(accountId: string): BusinessRecord | undefined;
  saveBusiness(record: BusinessRecord): void;
  listEvents(): Record<string, unknown>[];
  appendEvent(event: Record<string, unknown>): void;
  getWorkerState(key: string): string | undefined;
  setWorkerState(key: string, value: string): void;
}

export interface ApiKeyStore {
  create(record: ApiKeyRecord): void;
  list(accountId?: string): ApiKeyRecord[];
  findByHash(hash: string): ApiKeyRecord | undefined;
  update(record: ApiKeyRecord): void;
}

export interface SessionRecord {
  tokenHash: string;
  accountId: string;
  expiresAt: number;
  absoluteExpiresAt: number;
}

export interface SessionStore {
  create(record: SessionRecord): void;
  get(tokenHash: string): SessionRecord | undefined;
  touch(tokenHash: string, expiresAt: number): void;
  delete(tokenHash: string): void;
  prune(now: number): void;
}

export interface ChallengeStore {
  put(challenge: Challenge): void;
  take(nonce: string): Challenge | undefined;
  prune(now: number): void;
}

export interface IdempotencyRepository {
  get(key: string): { fingerprint: string; response: StoredResponse } | undefined;
  put(key: string, fingerprint: string, response: StoredResponse, createdAt: number): void;
  prune(before: number): void;
}

export interface Stores {
  api: ApiStore;
  keys: ApiKeyStore;
  sessions: SessionStore;
  challenges: ChallengeStore;
  idempotency: IdempotencyRepository;
  recurring: RecurringStore;
  docs: ModuleStore;
  close?: () => void;
}

export function createMemoryStores(): Stores {
  const invoices = new Map<string, InvoiceRecord>();
  const invoiceAccounts = new Map<string, string>();
  const payments = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const receiptTokens = new Map<string, string[]>();
  const receiptHashes = new Map<string, string>();
  const endpoints = new Map<string, WebhookEndpointRecord>();
  const endpointAccounts = new Map<string, string>();
  const deliveries = new Map<string, Record<string, unknown>[]>();
  const outbox = new Map<string, OutboxRow>();
  const paySessions = new Map<string, PaySession>();
  const openQuotes = new Map<string, Record<string, unknown>[]>();
  const businesses = new Map<string, BusinessRecord>();
  const events: Record<string, unknown>[] = [];
  const workerState = new Map<string, string>();
  const keys = new Map<string, ApiKeyRecord>();
  const sessions = new Map<string, SessionRecord>();
  const challenges = new Map<string, Challenge>();
  const idempotency = new Map<
    string,
    { fingerprint: string; response: StoredResponse; createdAt: number }
  >();

  return {
    api: {
      listInvoices(accountId) {
        return [...invoices.values()].filter(
          (invoice) => accountId === undefined || invoiceAccounts.get(invoice.id) === accountId,
        );
      },
      getInvoice(idOrToken) {
        return (
          invoices.get(idOrToken) ??
          [...invoices.values()].find((invoice) => invoice.token_id === idOrToken)
        );
      },
      saveInvoice(record) {
        invoices.set(record.id, record);
        invoiceAccounts.set(record.id, record.issuer_id);
      },
      listPayments: () => [...payments.values()],
      getPayment: (id) => payments.get(id),
      savePayment: (id, body) => payments.set(id, body),
      getReceipt(idOrHash) {
        return receipts.get(idOrHash) ?? receipts.get(receiptHashes.get(idOrHash) ?? "");
      },
      listReceipts(tokenId) {
        return (receiptTokens.get(tokenId) ?? [])
          .map((id) => receipts.get(id))
          .filter(Boolean) as Record<string, unknown>[];
      },
      saveReceipt(id, tokenId, bookingHash, body) {
        receipts.set(id, body);
        receiptHashes.set(bookingHash, id);
        const list = receiptTokens.get(tokenId) ?? [];
        list.push(id);
        receiptTokens.set(tokenId, list);
      },
      listWebhookEndpoints(accountId) {
        return [...endpoints.values()].filter(
          (endpoint) => accountId === undefined || endpointAccounts.get(endpoint.id) === accountId,
        );
      },
      getWebhookEndpoint: (id) => endpoints.get(id),
      saveWebhookEndpoint(accountId, endpoint) {
        endpoints.set(endpoint.id, endpoint);
        endpointAccounts.set(endpoint.id, accountId);
      },
      deleteWebhookEndpoint(id) {
        endpoints.delete(id);
        endpointAccounts.delete(id);
      },
      addDelivery(endpointId, delivery) {
        const list = deliveries.get(endpointId) ?? [];
        list.push(delivery);
        deliveries.set(endpointId, list);
      },
      listDeliveries: (endpointId) => deliveries.get(endpointId) ?? [],
      outboxEnqueue(endpointId, eventId, event, nextAttemptAt, expiresAt) {
        const key = `${endpointId}\u0000${eventId}`;
        if (outbox.has(key)) return false;
        outbox.set(key, {
          endpointId,
          eventId,
          event,
          attempt: 0,
          nextAttemptAt,
          expiresAt,
          delivered: false,
        });
        return true;
      },
      outboxDue(now) {
        return [...outbox.values()].filter((row) => !row.delivered && row.nextAttemptAt <= now);
      },
      outboxMarkDelivered(endpointId, eventId) {
        const row = outbox.get(`${endpointId}\u0000${eventId}`);
        if (row !== undefined) row.delivered = true;
      },
      outboxReschedule(endpointId, eventId, attempt, nextAttemptAt) {
        const row = outbox.get(`${endpointId}\u0000${eventId}`);
        if (row !== undefined) {
          row.attempt = attempt;
          row.nextAttemptAt = nextAttemptAt;
        }
      },
      outboxExpire(endpointId, eventId) {
        const row = outbox.get(`${endpointId}\u0000${eventId}`);
        if (row !== undefined) row.delivered = true;
      },
      getPaySession: (id) => paySessions.get(id),
      savePaySession: (session) => paySessions.set(session.id, session),
      getOpenQuotes: (tokenId) => openQuotes.get(tokenId) ?? [],
      saveOpenQuotes: (tokenId, quotes) => openQuotes.set(tokenId, quotes),
      getBusiness: (accountId) => businesses.get(accountId),
      saveBusiness: (record) => businesses.set(record.account_id, record),
      listEvents: () => events,
      appendEvent: (event) => events.push(event),
      getWorkerState: (key) => workerState.get(key),
      setWorkerState: (key, value) => workerState.set(key, value),
    },
    keys: {
      create: (record) => keys.set(record.id, record),
      list: (accountId) =>
        accountId === undefined
          ? [...keys.values()]
          : [...keys.values()].filter((key) => key.accountId === accountId),
      findByHash: (hash) => [...keys.values()].find((key) => key.hash === hash),
      update: (record) => keys.set(record.id, record),
    },
    sessions: {
      create: (record) => sessions.set(record.tokenHash, record),
      get: (tokenHash) => sessions.get(tokenHash),
      touch: (tokenHash, expiresAt) => {
        const record = sessions.get(tokenHash);
        if (record !== undefined) record.expiresAt = expiresAt;
      },
      delete: (tokenHash) => sessions.delete(tokenHash),
      prune: (now) => {
        for (const [tokenHash, record] of sessions)
          if (record.expiresAt <= now) sessions.delete(tokenHash);
      },
    },
    challenges: {
      put: (challenge) => challenges.set(challenge.nonce, challenge),
      take: (nonce) => {
        const challenge = challenges.get(nonce);
        challenges.delete(nonce);
        return challenge;
      },
      prune: (now) => {
        for (const [nonce, challenge] of challenges)
          if (challenge.expiresAt <= now) challenges.delete(nonce);
      },
    },
    idempotency: {
      get(key) {
        const entry = idempotency.get(key);
        return entry === undefined
          ? undefined
          : { fingerprint: entry.fingerprint, response: entry.response };
      },
      put(key, fingerprint, response, createdAt) {
        idempotency.set(key, { fingerprint, response, createdAt });
      },
      prune(before) {
        for (const [key, entry] of idempotency)
          if (entry.createdAt <= before) idempotency.delete(key);
      },
    },
    recurring: createMemoryRecurringStore(),
    docs: createMemoryModuleStore(),
  };
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export function createSqliteStores(path: string): Stores {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, token_id TEXT UNIQUE, account_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, token_id TEXT NOT NULL, booking_hash TEXT UNIQUE, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_endpoints (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_outbox (endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, attempt INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (endpoint_id, event_id));
    CREATE TABLE IF NOT EXISTS pay_sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS open_quotes (token_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS business_profiles (account_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));
  `);

  const api: ApiStore = {
    listInvoices(accountId) {
      const rows =
        accountId === undefined
          ? db.prepare("SELECT body FROM invoices").all()
          : db.prepare("SELECT body FROM invoices WHERE account_id = ?").all(accountId);
      return rows.map((row) => parseJson<InvoiceRecord>(row.body));
    },
    getInvoice(idOrToken) {
      const row = db
        .prepare("SELECT body FROM invoices WHERE id = ? OR token_id = ?")
        .get(idOrToken, idOrToken);
      return row === undefined ? undefined : parseJson<InvoiceRecord>(row.body);
    },
    saveInvoice(record) {
      db.prepare(
        "INSERT INTO invoices (id, token_id, account_id, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      ).run(record.id, record.token_id, record.issuer_id, JSON.stringify(record));
    },
    listPayments() {
      return db
        .prepare("SELECT body FROM payments ORDER BY rowid")
        .all()
        .map((row) => parseJson<Record<string, unknown>>(row.body));
    },
    getPayment(id) {
      const row = db.prepare("SELECT body FROM payments WHERE id = ?").get(id);
      return row === undefined ? undefined : parseJson<Record<string, unknown>>(row.body);
    },
    savePayment(id, body) {
      db.prepare(
        "INSERT INTO payments (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      ).run(id, JSON.stringify(body));
    },
    getReceipt(idOrHash) {
      const row = db
        .prepare("SELECT body FROM receipts WHERE id = ? OR booking_hash = ?")
        .get(idOrHash, idOrHash);
      return row === undefined ? undefined : parseJson<Record<string, unknown>>(row.body);
    },
    listReceipts(tokenId) {
      return db
        .prepare("SELECT body FROM receipts WHERE token_id = ?")
        .all(tokenId)
        .map((row) => parseJson<Record<string, unknown>>(row.body));
    },
    saveReceipt(id, tokenId, bookingHash, body) {
      db.prepare(
        "INSERT INTO receipts (id, token_id, booking_hash, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      ).run(id, tokenId, bookingHash, JSON.stringify(body));
    },
    listWebhookEndpoints(accountId) {
      const rows =
        accountId === undefined
          ? db.prepare("SELECT body FROM webhook_endpoints").all()
          : db.prepare("SELECT body FROM webhook_endpoints WHERE account_id = ?").all(accountId);
      return rows.map((row) => parseJson<WebhookEndpointRecord>(row.body));
    },
    getWebhookEndpoint(id) {
      const row = db.prepare("SELECT body FROM webhook_endpoints WHERE id = ?").get(id);
      return row === undefined ? undefined : parseJson<WebhookEndpointRecord>(row.body);
    },
    saveWebhookEndpoint(accountId, endpoint) {
      db.prepare(
        "INSERT INTO webhook_endpoints (id, account_id, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      ).run(endpoint.id, accountId, JSON.stringify(endpoint));
    },
    deleteWebhookEndpoint(id) {
      db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(id);
    },
    addDelivery(endpointId, delivery) {
      db.prepare("INSERT INTO webhook_deliveries (id, endpoint_id, body) VALUES (?, ?, ?)").run(
        String(delivery.id),
        endpointId,
        JSON.stringify(delivery),
      );
    },
    listDeliveries(endpointId) {
      return db
        .prepare("SELECT body FROM webhook_deliveries WHERE endpoint_id = ?")
        .all(endpointId)
        .map((row) => parseJson<Record<string, unknown>>(row.body));
    },
    outboxEnqueue(endpointId, eventId, event, nextAttemptAt, expiresAt) {
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO webhook_outbox (endpoint_id, event_id, event, attempt, next_attempt_at, expires_at, delivered) VALUES (?, ?, ?, 0, ?, ?, 0)",
        )
        .run(endpointId, eventId, event, nextAttemptAt, expiresAt);
      return Number(result.changes ?? 0) > 0;
    },
    outboxDue(now) {
      return db
        .prepare(
          "SELECT endpoint_id, event_id, event, attempt, next_attempt_at, expires_at FROM webhook_outbox WHERE delivered = 0 AND next_attempt_at <= ? ORDER BY next_attempt_at",
        )
        .all(now)
        .map((row) => ({
          endpointId: String(row.endpoint_id),
          eventId: String(row.event_id),
          event: String(row.event),
          attempt: Number(row.attempt),
          nextAttemptAt: Number(row.next_attempt_at),
          expiresAt: Number(row.expires_at),
          delivered: Number(row.delivered) === 1,
        }));
    },
    outboxMarkDelivered(endpointId, eventId) {
      db.prepare(
        "UPDATE webhook_outbox SET delivered = 1 WHERE endpoint_id = ? AND event_id = ?",
      ).run(endpointId, eventId);
    },
    outboxReschedule(endpointId, eventId, attempt, nextAttemptAt) {
      db.prepare(
        "UPDATE webhook_outbox SET attempt = ?, next_attempt_at = ? WHERE endpoint_id = ? AND event_id = ?",
      ).run(attempt, nextAttemptAt, endpointId, eventId);
    },
    outboxExpire(endpointId, eventId) {
      db.prepare(
        "UPDATE webhook_outbox SET delivered = 1 WHERE endpoint_id = ? AND event_id = ?",
      ).run(endpointId, eventId);
    },
    getPaySession(id) {
      const row = db.prepare("SELECT body FROM pay_sessions WHERE id = ?").get(id);
      return row === undefined ? undefined : parseJson<PaySession>(row.body);
    },
    savePaySession(session) {
      db.prepare(
        "INSERT INTO pay_sessions (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      ).run(session.id, JSON.stringify(session));
    },
    getOpenQuotes(tokenId) {
      const row = db.prepare("SELECT body FROM open_quotes WHERE token_id = ?").get(tokenId);
      return row === undefined ? [] : parseJson<Record<string, unknown>[]>(row.body);
    },
    saveOpenQuotes(tokenId, quotes) {
      db.prepare(
        "INSERT INTO open_quotes (token_id, body) VALUES (?, ?) ON CONFLICT(token_id) DO UPDATE SET body = excluded.body",
      ).run(tokenId, JSON.stringify(quotes));
    },
    getBusiness(accountId) {
      const row = db
        .prepare("SELECT body FROM business_profiles WHERE account_id = ?")
        .get(accountId);
      return row === undefined ? undefined : parseJson<BusinessRecord>(row.body);
    },
    saveBusiness(record) {
      db.prepare(
        "INSERT INTO business_profiles (account_id, body) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET body = excluded.body",
      ).run(record.account_id, JSON.stringify(record));
    },
    listEvents() {
      return db
        .prepare("SELECT body FROM events ORDER BY rowid")
        .all()
        .map((row) => parseJson<Record<string, unknown>>(row.body));
    },
    appendEvent(event) {
      db.prepare("INSERT OR IGNORE INTO events (id, body) VALUES (?, ?)").run(
        String(event.id ?? crypto.randomUUID()),
        JSON.stringify(event),
      );
    },
    getWorkerState(key) {
      const row = db.prepare("SELECT value FROM worker_state WHERE key = ?").get(key);
      return row === undefined ? undefined : String(row.value);
    },
    setWorkerState(key, value) {
      db.prepare(
        "INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    },
  };

  const keys: ApiKeyStore = {
    create(record) {
      db.prepare("INSERT INTO api_keys (id, account_id, hash, body) VALUES (?, ?, ?, ?)").run(
        record.id,
        record.accountId,
        record.hash,
        JSON.stringify(record),
      );
    },
    list(accountId) {
      const rows =
        accountId === undefined
          ? db.prepare("SELECT body FROM api_keys").all()
          : db.prepare("SELECT body FROM api_keys WHERE account_id = ?").all(accountId);
      return rows.map((row) => parseJson<ApiKeyRecord>(row.body));
    },
    findByHash(hash) {
      const row = db.prepare("SELECT body FROM api_keys WHERE hash = ?").get(hash);
      return row === undefined ? undefined : parseJson<ApiKeyRecord>(row.body);
    },
    update(record) {
      db.prepare("UPDATE api_keys SET hash = ?, body = ? WHERE id = ?").run(
        record.hash,
        JSON.stringify(record),
        record.id,
      );
    },
  };

  const sessions: SessionStore = {
    create(record) {
      db.prepare(
        "INSERT INTO sessions (token_hash, account_id, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?)",
      ).run(record.tokenHash, record.accountId, record.expiresAt, record.absoluteExpiresAt);
    },
    get(tokenHash) {
      const row = db
        .prepare(
          "SELECT token_hash, account_id, expires_at, absolute_expires_at FROM sessions WHERE token_hash = ?",
        )
        .get(tokenHash) as Record<string, unknown> | undefined;
      return row === undefined
        ? undefined
        : {
            tokenHash: String(row.token_hash),
            accountId: String(row.account_id),
            expiresAt: Number(row.expires_at),
            absoluteExpiresAt: Number(row.absolute_expires_at),
          };
    },
    touch(tokenHash, expiresAt) {
      db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
        expiresAt,
        tokenHash,
      );
    },
    delete(tokenHash) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },
    prune(now) {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    },
  };

  const challenges: ChallengeStore = {
    put(challenge) {
      db.prepare(
        "INSERT INTO challenges (nonce, account_id, expires_at, body) VALUES (?, ?, ?, ?) ON CONFLICT(nonce) DO UPDATE SET body = excluded.body",
      ).run(challenge.nonce, challenge.accountId, challenge.expiresAt, JSON.stringify(challenge));
    },
    take(nonce) {
      const row = db.prepare("SELECT body FROM challenges WHERE nonce = ?").get(nonce);
      db.prepare("DELETE FROM challenges WHERE nonce = ?").run(nonce);
      return row === undefined ? undefined : parseJson<Challenge>(row.body);
    },
    prune(now) {
      db.prepare("DELETE FROM challenges WHERE expires_at <= ?").run(now);
    },
  };

  const idempotency: IdempotencyRepository = {
    get(key) {
      const row = db
        .prepare("SELECT fingerprint, status, body FROM idempotency WHERE key = ?")
        .get(key) as Record<string, unknown> | undefined;
      return row === undefined
        ? undefined
        : {
            fingerprint: String(row.fingerprint),
            response: { status: Number(row.status), body: parseJson<unknown>(row.body) },
          };
    },
    put(key, fingerprint, response, createdAt) {
      db.prepare(
        "INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, status = excluded.status, body = excluded.body, created_at = excluded.created_at",
      ).run(key, fingerprint, response.status, JSON.stringify(response.body), createdAt);
    },
    prune(before) {
      db.prepare("DELETE FROM idempotency WHERE created_at <= ?").run(before);
    },
  };

  return {
    api,
    keys,
    sessions,
    challenges,
    idempotency,
    recurring: createSqliteRecurringStore(db),
    docs: createSqliteModuleStore(db),
    close: () => db.close(),
  };
}
