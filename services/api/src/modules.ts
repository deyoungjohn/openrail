/**
 * Module host for the API. Core never names a module: it loads whatever `enabled.ts` lists (generated
 * from `openrail.modules.json`) and offers each one routes, event hooks and a namespaced document
 * store. A switched-off module is absent, so none of its routes or events exist.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ApiConfig, ApiRequest, ApiResponse, IssuerPort } from "./app.js";
import type { ApiStore } from "./stores.js";
import type { AuthContext } from "./auth.js";
import type { IndexedEvent } from "./webhooks.js";

/** Small document store, one namespace per module collection. */
export interface ModuleStore {
  get<T>(ns: string, id: string): T | undefined;
  put<T>(ns: string, id: string, doc: T, owner?: string): void;
  /** Inserts only if `(ns, id)` is new; false otherwise. Use for unique keys and claims. */
  insert<T>(ns: string, id: string, doc: T, owner?: string): boolean;
  delete(ns: string, id: string): void;
  /** Documents of a namespace, optionally of one owner, ordered by id. */
  list<T>(ns: string, owner?: string): T[];
}

export interface ApiModuleContext {
  config: ApiConfig;
  contract: import("./app.js").ContractPort;
  store: ApiStore;
  docs: ModuleStore;
  issuer: IssuerPort;
  clock: () => Date;
  /** Throws the core 401/403 errors. `allowPublishable` admits publishable keys. */
  requireAuth(request: ApiRequest, allowPublishable?: boolean): AuthContext;
  requireScope(context: AuthContext, scope: string): void;
  withIdempotency(request: ApiRequest, run: () => Promise<ApiResponse>): Promise<ApiResponse>;
  /** Read-only contract view; the module supplies its own method name and arguments. */
  view(contractMethod: string, args: object): Promise<unknown>;
  indexer?: import("./app.js").IndexerPort;
}

export interface ApiModule {
  readonly id: string;
  /** Event types this module can deliver to a webhook. Core has none. */
  readonly eventTypes?: string[];
  /** Returns a response for routes it owns, or undefined to pass. Throw `ApiError` for errors. */
  route?(request: ApiRequest, context: ApiModuleContext): Promise<ApiResponse | undefined>;
  /** Extra events derived from an indexed event (for example a module-specific event type). */
  events?(event: IndexedEvent, context: ApiModuleContext): IndexedEvent[];
  /**
   * Token ids of the claims this module keeps for a merchant. Core keeps a merchant's own events in
   * `GET /v1/events` by token, and claims a module issues are not in the invoice list.
   */
  ownedTokens?(accountId: string, context: ApiModuleContext): string[];
  /**
   * Asked before a pay quote is requested for a claim. A module that owns the claim may refuse it
   * (throw `ApiError`) or cap the quote deadline: `notAfter` is a unix time in seconds, and the
   * quote's deadline never goes past it. Returns undefined for claims it does not own.
   */
  quoteWindow?(tokenId: string, context: ApiModuleContext): Promise<QuoteWindow | undefined>;
}

export interface QuoteWindow {
  notAfter: number;
}

/** Picks the `apiModule` export of each enabled module that has one. */
export function apiModulesFrom(enabled: readonly { id: string; module: unknown }[]): ApiModule[] {
  const found: ApiModule[] = [];
  for (const entry of enabled) {
    const candidate = (entry.module as { apiModule?: ApiModule } | null)?.apiModule;
    if (candidate !== undefined && candidate !== null) found.push(candidate);
  }
  return found;
}

/**
 * Runs every module's `events` hook; the original event always comes first. A module whose hook throws is
 * skipped and logged: one broken module must never stop core events from being delivered.
 */
export function expandEvents(
  event: IndexedEvent,
  modules: readonly ApiModule[],
  context: ApiModuleContext,
  log: (line: string) => void = (line) => console.error(line),
): IndexedEvent[] {
  const out = [event];
  for (const module of modules) {
    if (module.events === undefined) continue;
    try {
      out.push(...module.events(event, context));
    } catch (error) {
      log(
        `module ${module.id} events hook failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return out;
}

function key(ns: string, id: string): string {
  return `${ns}\u0000${id}`;
}

export function createMemoryModuleStore(): ModuleStore {
  const docs = new Map<string, { ns: string; id: string; owner: string | null; body: unknown }>();
  return {
    get: <T>(ns: string, id: string) => {
      const found = docs.get(key(ns, id));
      return found === undefined ? undefined : (structuredClone(found.body) as T);
    },
    put: (ns, id, doc, owner) => {
      docs.set(key(ns, id), { ns, id, owner: owner ?? null, body: structuredClone(doc) });
    },
    insert: (ns, id, doc, owner) => {
      if (docs.has(key(ns, id))) return false;
      docs.set(key(ns, id), { ns, id, owner: owner ?? null, body: structuredClone(doc) });
      return true;
    },
    delete: (ns, id) => {
      docs.delete(key(ns, id));
    },
    list: <T>(ns: string, owner?: string) =>
      [...docs.values()]
        .filter((doc) => doc.ns === ns && (owner === undefined || doc.owner === owner))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((doc) => structuredClone(doc.body) as T),
  };
}

export function createSqliteModuleStore(db: DatabaseSync): ModuleStore {
  db.exec(
    "CREATE TABLE IF NOT EXISTS module_docs (ns TEXT NOT NULL, id TEXT NOT NULL, owner TEXT, body TEXT NOT NULL, PRIMARY KEY (ns, id)); CREATE INDEX IF NOT EXISTS module_docs_owner ON module_docs (ns, owner);",
  );
  const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
  return {
    get<T>(ns: string, id: string) {
      const row = db.prepare("SELECT body FROM module_docs WHERE ns = ? AND id = ?").get(ns, id);
      return row === undefined ? undefined : parse<T>(row.body);
    },
    put(ns, id, doc, owner) {
      db.prepare(
        "INSERT INTO module_docs (ns, id, owner, body) VALUES (?, ?, ?, ?) ON CONFLICT(ns, id) DO UPDATE SET owner = excluded.owner, body = excluded.body",
      ).run(ns, id, owner ?? null, JSON.stringify(doc));
    },
    insert(ns, id, doc, owner) {
      const result = db
        .prepare("INSERT OR IGNORE INTO module_docs (ns, id, owner, body) VALUES (?, ?, ?, ?)")
        .run(ns, id, owner ?? null, JSON.stringify(doc));
      return Number(result.changes) === 1;
    },
    delete(ns, id) {
      db.prepare("DELETE FROM module_docs WHERE ns = ? AND id = ?").run(ns, id);
    },
    list<T>(ns: string, owner?: string) {
      const rows =
        owner === undefined
          ? db.prepare("SELECT body FROM module_docs WHERE ns = ? ORDER BY id").all(ns)
          : db
              .prepare("SELECT body FROM module_docs WHERE ns = ? AND owner = ? ORDER BY id")
              .all(ns, owner);
      return rows.map((row) => parse<T>(row.body));
    },
  };
}
