/** Core API implementation (S1b). Dependencies are ports so tests stay offline. */
import { randomBytes } from "node:crypto";
import {
  allowedRoutes,
  getRoute,
  loadRoutes,
  usdToBaseUnits,
  type RouteFile,
} from "@openrail/shared";
import { AddressError, validateRefundAddress } from "./addresses.js";
import {
  AuthError,
  AuthStore,
  SECRET_KEY_SCOPES,
  verifyNep413,
  type AuthContext,
  type Nep413Verifier,
} from "./auth.js";
import { sha256Hex0x } from "./crypto.js";
import { createMemoryStores, type ApiStore } from "./stores.js";
import { IdempotencyConflict, IdempotencyStore } from "./idempotency.js";
import { renderInvoicePdfBase64 } from "./pdf.js";
import { PROCESSING_FEE_DESCRIPTION } from "./line-items.js";
import { handleRecurring, type RecurringStore } from "./recurring.js";
import { createMemoryRecurringStore } from "./recurring-store.js";
import { enabledModules } from "./enabled.js";
import {
  apiModulesFrom,
  createMemoryModuleStore,
  type ApiModule,
  type ApiModuleContext,
  type ModuleStore,
} from "./modules.js";
import { QuoteError, QuoteService, type ClaimSnapshot, type QuoteProvider } from "./quote.js";
import { CORE_CLAUSES, buildTerms, termsHash, type Terms } from "./terms.js";
import {
  CORE_WEBHOOK_EVENT_TYPES,
  deliverTestWebhook,
  type WebhookEndpointRecord,
} from "./webhooks.js";
import { UnsafeWebhookUrl, validateWebhookUrl } from "./webhook-url.js";
import {
  feePreview,
  lineItemsFingerprint,
  normalizeLineItems,
  resolveFee,
  type FeeMode,
  type LineItem,
} from "./line-items.js";
import {
  ackLink,
  claimLabel as claimLabelFor,
  isImplicitAccountId,
  normalizeUsername,
  payLink,
  refOf,
  usernameAvailability,
  usernameProblem,
} from "./links.js";

export interface ApiConfig {
  rootAccount: string;
  recipient: string;
  payBaseUrl: string;
  /** REL-2: new invoices get `<username>-<ref>` claim labels. Off until the contract supports them. */
  claimLabels?: boolean;
}

export interface ContractPort {
  /** Module support: held settle entries for one token. */
  settleHeld?(tokenId: string): Promise<Record<string, unknown>[]>;
  claim(tokenId: string): Promise<Record<string, unknown> & { kind: number }>;
  /** Generic read-only view for enabled modules; core never names their methods. */
  view?(methodName: string, args: object): Promise<unknown>;
  storageCredit(accountId: string): Promise<{ balance: string; amount: string }>;
  sponsorStatus?(accountId: string): Promise<{ pool: string; cap: number; used: number }>;
}

export interface IssuerPort {
  prepareIssue(accountId: string): Promise<{
    tokenId?: string;
    claimAccount?: string;
    /** `storage_credit_of(business)` and the deposit one invoice needs, in yoctoNEAR (when the issuer reports them). */
    storageCredit?: string;
    amount?: string;
    /** The account the business deposits storage credit to. */
    account?: string;
    sponsored?: boolean;
    sponsorPool?: string;
    sponsorCap?: number;
    sponsorUsed?: number;
    sponsoredRemaining?: number;
  }>;
  issueFor(request: {
    business: string;
    kind: number;
    debtor: { Near: string } | { Evm: string } | null;
    termsHash: string;
    amountDue: string;
    dueDate: number;
    metadata?: Record<string, unknown>;
    /** The id `prepareIssue` predicted; the issuer refuses a mint that took another (409 token_id_mismatch). */
    expectedTokenId?: string;
    /** REL-2: the label the contract should use; ignored while the issuer flag is off. */
    claimLabel?: string;
  }): Promise<{ txHash: string; tokenId?: string; claimAccount?: string }>;
  logQuote(request: {
    tokenId: string;
    quoteId: string;
    depositAddress: string;
    deadlineRequested: number;
    refundTo: string;
    routeId: string;
  }): Promise<{ txHash: string }>;
  acknowledgeEvm(request: { tokenId: string; chainId: number; signature: string }): Promise<{
    txHash: string;
    ack: unknown;
  }>;
}

export interface AccessKeyPort {
  has(accountId: string, publicKey: string): Promise<boolean>;
}

export interface IndexerPort {
  listReceipts(accountId: string, tokenId: string): Promise<Record<string, unknown>[]>;
  getReceipt(bookingTxHash: string): Promise<Record<string, unknown> | undefined>;
  getStatement(
    accountId: string,
    query: { from?: string; to?: string; format: "csv" | "pdf"; tokenId?: string },
  ): Promise<Record<string, unknown>>;
  listEvents(query: {
    after?: string;
    type?: string;
    limit?: number;
  }): Promise<{ data: Record<string, unknown>[]; next_cursor?: string | null }>;
  analytics(): Promise<Record<string, unknown>>;
}

export type PayoutSchedule = "manual" | "each_payment" | "daily" | "weekly" | "monthly";

export interface PayoutEstimatorPort {
  estimate(destination: string): Promise<Record<string, unknown>>;
}

export interface CashoutPort {
  quote(request: {
    amount: string;
    destinationChain: string;
    address: string;
    /** The business account: where the provider returns the money if the cash-out fails. */
    refundTo: string;
  }): Promise<Record<string, unknown>>;
}

export interface BusinessRecord {
  account_id: string;
  username: string | null;
  legal_name: string;
  payout_account: string;
  contact_email: string;
  fee_mode?: FeeMode;
  payout?: { schedule: PayoutSchedule; destination: string | null };
  created_at: string;
  updated_at: string;
  /** Internal: set when the business replaces a non-null username. Never returned. */
  username_changed_at?: string;
}

export interface InvoiceRecord {
  id: string;
  token_id: string;
  claim_account: string;
  status: string;
  issuer_id: string;
  owner_id: string;
  debtor: { Near: string } | { Evm: string } | null;
  terms_hash: string;
  amount_due: string;
  outstanding: string;
  paid_total: string;
  amount_usd: string;
  due_date: string;
  invoice_number: string;
  issuer_legal_name: string;
  debtor_legal_name: string;
  pay_link: string;
  ack_url: string;
  created_at: string;
  created_block: number;
  terms: Terms;
  line_items?: LineItem[];
  fee_mode?: FeeMode;
  /** Set when the invoice was issued by a recurring template. */
  recurring_id?: string;
}

export function createStore(): ApiStore {
  return createMemoryStores().api;
}

export function kindRules(kind: number): ClaimSnapshot["kindRules"] {
  if (kind === 0) {
    return {
      ack_required_for_sale: true,
      sellable: true,
      quote_deadline: 3600,
      debtor_optional: false,
    };
  }
  return {
    ack_required_for_sale: true,
    sellable: false,
    quote_deadline: 3600,
    debtor_optional: false,
  };
}

type Headers = Record<string, string | undefined>;

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: string;
  readonly rule?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message = code,
    rule?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.rule = rule;
    this.details = details;
  }
}

export interface ApiDeps {
  config: ApiConfig;
  store?: ApiStore;
  recurring?: RecurringStore;
  /** Module document store (namespaced). */
  docs?: ModuleStore;
  /** Enabled API modules; defaults to the generated `enabled.ts`. */
  modules?: ApiModule[];
  auth?: AuthStore;
  idempotency?: IdempotencyStore;
  contract: ContractPort;
  issuer: IssuerPort;
  accessKey: AccessKeyPort;
  cashout: CashoutPort;
  payoutEstimator?: PayoutEstimatorPort;
  indexer?: IndexerPort;
  verifier?: Nep413Verifier;
  routes?: RouteFile;
  clock?: () => Date;
  quoteProvider?: QuoteProvider;
  spec?: Record<string, unknown>;
  webhookFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  webhookUrlValidator?: (url: string) => Promise<unknown>;
  pokeIndexer?: () => Promise<void>;
}

/** The provider's status word as the API's payment status. A short deposit stays pending: it waits for the rest. */
export function paymentStatusOf(
  provider: string,
): "pending_deposit" | "processing" | "success" | "refunded" | "failed" {
  switch (provider) {
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return "processing";
    case "SUCCESS":
      return "success";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    default:
      return "pending_deposit";
  }
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

function twoDecimals(value: number): string {
  return value.toFixed(2);
}

function parseDebtor(input: unknown): { Near: string } | { Evm: string } | null {
  if (typeof input !== "string" || input === "") return null;
  return input.startsWith("0x") ? { Evm: input } : { Near: input };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function dateToUtc(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

function cookieToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "or_sess") return rest.join("=");
  }
  return undefined;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  const domain = process.env.COOKIE_DOMAIN;
  return [
    `or_sess=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(domain === undefined || domain === "" ? [] : [`Domain=${domain}`]),
  ].join("; ");
}

function allowedOrigins(): string[] {
  return (process.env.WEB_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}

const toBig = (v: unknown): bigint => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : 0n);

/**
 * What is still owed, read from the claim's own counters (blueprint 2.3): amount due, less what was
 * booked without the surplus, less credit, never below zero. An explicit `outstanding` wins (fixtures).
 */
export function outstandingOf(claim: Record<string, unknown>): string {
  if (typeof claim.outstanding === "string") return claim.outstanding;
  if (typeof claim.amount_due !== "string") return "0";
  const owed =
    toBig(claim.amount_due) -
    (toBig(claim.booked_total) - toBig(claim.surplus)) -
    toBig(claim.credit_total);
  return (owed < 0n ? 0n : owed).toString();
}

/** Money applied to the invoice so far: what was booked, without the surplus. */
export function paidTotalOf(claim: Record<string, unknown>, fallback: string): string {
  if (typeof claim.booked_total !== "string") return fallback;
  const paid = toBig(claim.booked_total) - toBig(claim.surplus);
  return (paid < 0n ? 0n : paid).toString();
}

export class ApiApp {
  readonly store: ApiStore;
  readonly recurring: RecurringStore;
  readonly docs: ModuleStore;
  readonly modules: readonly ApiModule[];
  private readonly auth: AuthStore;
  private readonly idempotency: IdempotencyStore;
  private readonly clock: () => Date;
  private readonly quotes: QuoteService;
  private readonly routes: RouteFile;
  private readonly verifier: Nep413Verifier;

  constructor(private readonly deps: ApiDeps) {
    this.store = deps.store ?? createMemoryStores().api;
    this.recurring = deps.recurring ?? createMemoryRecurringStore();
    this.docs = deps.docs ?? createMemoryModuleStore();
    this.modules = deps.modules ?? apiModulesFrom(enabledModules);
    this.auth = deps.auth ?? new AuthStore();
    this.idempotency = deps.idempotency ?? new IdempotencyStore();
    this.clock = deps.clock ?? (() => new Date());
    this.routes = deps.routes ?? loadRoutes();
    this.verifier = deps.verifier ?? verifyNep413;
    this.quotes = new QuoteService({
      routes: this.routes,
      claim: (tokenId) => this.claimSnapshot(tokenId),
      provider: deps.quoteProvider ?? {
        quote: async (request) => ({
          quoteId: id("q"),
          depositAddress: request.refundTo === "" ? `deposit_${id("addr")}` : request.refundTo,
          deadline: request.deadline,
          amountIn: request.amount,
          amountOut: request.amount,
          spreadBps: 0,
        }),
      },
      logger: deps.issuer,
      clock: this.clock,
    });
  }

  private requireAuth(request: ApiRequest, allowPublishable = false): AuthContext {
    const header = request.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    const cookie = cookieToken(request.headers.cookie);
    const token = bearer ?? cookie;
    const source = bearer === undefined ? "cookie" : "bearer";
    if (source === "cookie" && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin === undefined || !allowedOrigins().includes(origin)) {
        throw new ApiError(
          403,
          "csrf_origin",
          "cookie-authenticated request needs an allowed Origin",
        );
      }
      if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        throw new ApiError(
          403,
          "csrf_content_type",
          "cookie-authenticated POST needs application/json",
        );
      }
    }
    const context = this.auth.authenticate(token, source);
    if (context.kind === "publishable" && !allowPublishable) {
      throw new ApiError(403, "forbidden", "publishable keys may only create pay sessions");
    }
    return context;
  }

  private requireScope(context: AuthContext, scope: string): void {
    if (context.kind === "session") return;
    if (!context.scopes.includes(scope)) {
      throw new ApiError(403, "insufficient_scope", `missing scope: ${scope}`);
    }
  }

  private async claimSnapshot(tokenId: string): Promise<ClaimSnapshot> {
    const claim = await this.deps.contract.claim(tokenId);
    return {
      tokenId: String(claim.token_id ?? tokenId),
      claimAccount: String(claim.claim_account ?? ""),
      termsHash: String(claim.terms_hash ?? ""),
      outstanding: typeof claim.amount_due === "string" ? outstandingOf(claim) : "0",
      amountDue: String(claim.amount_due ?? "0"),
      kindRules: kindRules(Number(claim.kind ?? 0)),
    };
  }

  /** An invoice of this merchant. Another merchant's invoice answers like one that does not exist. */
  private ownInvoice(accountId: string, idOrToken: string): InvoiceRecord {
    const invoice = this.invoiceBy(idOrToken);
    if (invoice.issuer_id !== accountId) throw new ApiError(404, "invoice_not_found");
    return invoice;
  }

  private invoiceBy(idOrToken: string): InvoiceRecord {
    // A public link carries the invoice id without its `inv_` prefix.
    const invoice = this.store.getInvoice(idOrToken) ?? this.store.getInvoice(`inv_${idOrToken}`);
    if (invoice === undefined) throw new ApiError(404, "invoice_not_found");
    return invoice;
  }

  private businessView(record: BusinessRecord): Omit<BusinessRecord, "username_changed_at"> {
    return {
      account_id: record.account_id,
      username: record.username,
      legal_name: record.legal_name,
      payout_account: record.payout_account,
      contact_email: record.contact_email,
      fee_mode: record.fee_mode ?? "absorb",
      payout: record.payout ?? { schedule: "manual", destination: null },
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }

  private readonly claimCache = new Map<string, { at: number; claim: Record<string, unknown> }>();

  /**
   * The invoices as they are on chain now: status, what is still owed and what was paid come from each
   * claim, not from the record written at creation (which never changes). A claim that cannot be read
   * keeps its stored values. Reads are cached for ten seconds and run eight at a time.
   */
  private async liveInvoices(invoices: InvoiceRecord[]): Promise<unknown[]> {
    const now = this.clock().getTime();
    const out: unknown[] = new Array<unknown>(invoices.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        const invoice = invoices[index];
        if (invoice === undefined) return;
        let claim: Record<string, unknown> | undefined;
        const cached = this.claimCache.get(invoice.token_id);
        if (cached !== undefined && now - cached.at < 10_000) claim = cached.claim;
        else {
          try {
            claim = await this.deps.contract.claim(invoice.token_id);
            this.claimCache.set(invoice.token_id, { at: now, claim });
          } catch {
            claim = undefined;
          }
        }
        out[index] =
          claim === undefined || typeof claim.amount_due !== "string"
            ? this.invoiceView(invoice)
            : {
                ...this.invoiceView(invoice),
                ...(typeof claim.status === "string" ? { status: claim.status } : {}),
                outstanding: outstandingOf(claim),
                paid_total: paidTotalOf(claim, invoice.paid_total),
              };
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, invoices.length) }, worker));
    return out;
  }

  private invoiceView(invoice: InvoiceRecord): Omit<InvoiceRecord, "terms"> & { terms?: Terms } {
    return invoice;
  }

  private business(accountId: string): BusinessRecord {
    const existing = this.store.getBusiness(accountId);
    if (existing !== undefined) {
      if (existing.username === undefined || existing.fee_mode === undefined) {
        if (existing.username === undefined)
          existing.username = isImplicitAccountId(accountId) ? null : accountId.toLowerCase();
        existing.fee_mode = existing.fee_mode ?? "absorb";
        this.store.saveBusiness(existing);
      }
      return existing;
    }
    const created: BusinessRecord = {
      account_id: accountId,
      username: isImplicitAccountId(accountId) ? null : accountId.toLowerCase(),
      legal_name: accountId,
      payout_account: accountId,
      contact_email: "billing@example.com",
      fee_mode: "absorb",
      payout: { schedule: "manual", destination: null },
      created_at: nowIso(this.clock),
      updated_at: nowIso(this.clock),
    };
    this.store.saveBusiness(created);
    return created;
  }

  private async withIdempotency(
    request: ApiRequest,
    handler: () => Promise<ApiResponse>,
  ): Promise<ApiResponse> {
    const key = request.headers["idempotency-key"];
    if (key === undefined || key === "") return handler();
    const stored = this.idempotency.get(key, request.body);
    if (stored !== undefined) return { status: stored.status, body: stored.body };
    const response = await handler();
    this.idempotency.put(key, request.body, { status: response.status, body: response.body });
    return response;
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    try {
      return await this.route(request);
    } catch (error) {
      return this.errorResponse(error);
    }
  }

  private errorResponse(error: unknown): ApiResponse {
    if (error instanceof IdempotencyConflict) {
      return {
        status: 409,
        body: { error: { code: "idempotency_key_reuse", message: error.message } },
      };
    }
    if (error instanceof AuthError) {
      return {
        status: error.status,
        body: { error: { code: error.code, message: error.message } },
      };
    }
    if (error instanceof QuoteError) {
      return {
        status: error.status,
        body: { error: { code: error.code, message: error.message } },
      };
    }
    if (error instanceof Error && error.message.startsWith("TERMS_INVALID")) {
      return { status: 400, body: { error: { code: "invalid_terms", message: error.message } } };
    }
    if (error instanceof ApiError) {
      return {
        status: error.status,
        body: {
          error: {
            code: error.code,
            message: error.message,
            ...(error.rule ? { rule: error.rule } : {}),
            ...(error.details ?? {}),
          },
        },
      };
    }
    // Anything else is a bug or an outage: it must reach the journal, which the response never shows.
    console.error(
      "unhandled error in the api",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    return { status: 500, body: { error: { code: "internal_error", message: "internal error" } } };
  }

  private async route(request: ApiRequest): Promise<ApiResponse> {
    const { method, path } = request;
    if (method === "GET" && path === "/v1/health") {
      return { status: 200, body: { ok: true, mock: false } };
    }
    if (method === "GET" && path === "/v1/openapi.json") {
      return { status: 200, body: this.deps.spec ?? {} };
    }
    if (method === "GET" && path === "/v1/routes") {
      this.requireAuth(request);
      return {
        status: 200,
        body: {
          data: allowedRoutes(this.routes).map((route) => ({
            id: route.id,
            origin_chain: route.originChain,
            payer_asset: route.payerAsset,
            origin_asset_id: route.originAssetId,
            origin_decimals: route.originDecimals,
            origin_contract: route.originContract,
            swap_type: route.swapType,
            destination_asset_id: route.destinationAssetId,
            evm_chain_id: route.evmChainId,
            rpc_var: route.rpcVar,
            part_b: route.partB,
          })),
        },
      };
    }
    if (method === "POST" && path === "/v1/auth/challenge") {
      return this.withIdempotency(request, async () => {
        const body = (request.body ?? {}) as { account_id?: string };
        if (body.account_id === undefined)
          throw new ApiError(400, "invalid_request", "account_id required");
        return {
          status: 200,
          body: this.auth.challenge(body.account_id, this.deps.config.recipient),
        };
      });
    }
    if (method === "POST" && path === "/v1/auth/verify") {
      return this.withIdempotency(request, async () => {
        const body = (request.body ?? {}) as {
          account_id?: string;
          public_key?: string;
          signature?: string;
          nonce?: string;
        };
        if (!body.account_id || !body.public_key || !body.signature || !body.nonce) {
          throw new ApiError(
            400,
            "invalid_request",
            "account_id, public_key, signature and nonce are required",
          );
        }
        const session = await this.auth.verify(
          {
            accountId: body.account_id,
            publicKey: body.public_key,
            signature: body.signature,
            nonce: body.nonce,
          },
          this.verifier,
          (accountId, publicKey) => this.deps.accessKey.has(accountId, publicKey),
        );
        return {
          status: 200,
          headers: { "set-cookie": sessionCookie(session.sessionToken, 7 * 24 * 60 * 60) },
          body: {
            session_token: session.sessionToken,
            account_id: session.accountId,
            expires_at: session.expiresAt,
          },
        };
      });
    }

    if (path === "/v1/auth/session" && method === "GET") {
      const context = this.requireAuth(request);
      if (context.kind !== "session" || context.session === undefined) {
        throw new ApiError(401, "unauthorized");
      }
      return {
        status: 200,
        body: {
          account_id: context.accountId,
          expires_at: new Date(context.session.expiresAt).toISOString(),
        },
      };
    }
    if (path === "/v1/auth/logout" && method === "POST") {
      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ")
        ? header.slice(7)
        : cookieToken(request.headers.cookie);
      if (token !== undefined) this.auth.logout(token);
      return {
        status: 200,
        headers: { "set-cookie": sessionCookie("", 0) },
        body: { ok: true },
      };
    }

    const apiKeyMatch = /^\/v1\/api_keys(?:\/([^/]+))?(?:\/(rotate))?$/.exec(path);
    if (apiKeyMatch !== null) {
      const context = this.requireAuth(request);
      const keyId = apiKeyMatch[1];
      const rotate = apiKeyMatch[2] === "rotate";
      if (method === "GET" && keyId === undefined) {
        return {
          status: 200,
          body: {
            data: this.auth.listApiKeys(context.accountId).map((key) => ({
              id: key.id,
              name: key.name,
              prefix: key.prefix,
              scopes: key.scopes,
              created_at: key.createdAt,
              last_used_at: key.lastUsedAt,
              revoked_at: key.revokedAt,
            })),
          },
        };
      }
      if (method === "POST" && keyId === undefined) {
        return this.withIdempotency(request, async () => {
          const body = (request.body ?? {}) as { name?: string; scopes?: string[] };
          const result = this.auth.createApiKey(
            context.accountId,
            body.name ?? "Untitled",
            "secret",
            body.scopes ?? [...SECRET_KEY_SCOPES],
          );
          return {
            status: 201,
            body: {
              id: result.record.id,
              name: result.record.name,
              prefix: result.record.prefix,
              secret: result.secret,
              scopes: result.record.scopes,
              created_at: result.record.createdAt,
            },
          };
        });
      }
      if (method === "POST" && keyId !== undefined && rotate) {
        return this.withIdempotency(request, async () => {
          const result = this.auth.rotateApiKey(keyId, context.accountId);
          return {
            status: 200,
            body: {
              id: result.record.id,
              name: result.record.name,
              prefix: result.record.prefix,
              secret: result.secret,
              scopes: result.record.scopes,
              created_at: result.record.createdAt,
            },
          };
        });
      }
      if (method === "DELETE" && keyId !== undefined) {
        this.auth.revokeApiKey(keyId, context.accountId);
        return { status: 200, body: { id: keyId, deleted: true } };
      }
    }

    if (path === "/v1/business" && (method === "GET" || method === "PUT")) {
      const context = this.requireAuth(request);
      const current = this.business(context.accountId);
      if (method === "PUT") {
        const body = (request.body ?? {}) as {
          username?: unknown;
          legal_name?: unknown;
          payout_account?: unknown;
          contact_email?: unknown;
          fee_mode?: unknown;
          payout?: unknown;
        };
        if (body.username !== undefined) {
          if (typeof body.username !== "string") throw new ApiError(400, "invalid_username");
          const requested = normalizeUsername(body.username);
          const same = current.username !== null && requested === current.username;
          const taken = same ? false : this.store.usernameTaken(requested, this.clock().getTime());
          if (!same) {
            const problem = usernameProblem(requested, context.accountId);
            if (problem !== null) {
              throw new ApiError(
                400,
                "invalid_username",
                problem === "reserved"
                  ? "Username is reserved"
                  : "Username must be 3-32 lowercase letters, digits, - or _",
              );
            }
            if (taken) throw new ApiError(409, "username_taken", "Username is already taken");
          }
          if (!same) {
            const now = this.clock();
            if (current.username !== null && current.username_changed_at !== undefined) {
              const allowedAt = Date.parse(current.username_changed_at) + 30 * 24 * 60 * 60 * 1000;
              if (now.getTime() < allowedAt) {
                const allowedIso = new Date(allowedAt).toISOString();
                throw new ApiError(
                  429,
                  "username_change_too_soon",
                  `Username can be changed again on ${allowedIso}`,
                  undefined,
                  { allowed_at: allowedIso },
                );
              }
            }
            if (current.username !== null) {
              this.store.releaseBusinessUsername(
                current.username,
                now.getTime() + 30 * 24 * 60 * 60 * 1000,
              );
              current.username_changed_at = nowIso(this.clock);
            }
            current.username = requested;
          }
        }
        if (body.legal_name !== undefined) {
          if (typeof body.legal_name !== "string") throw new ApiError(400, "invalid_request");
          current.legal_name = body.legal_name;
        }
        if (body.payout_account !== undefined) {
          if (typeof body.payout_account !== "string") throw new ApiError(400, "invalid_request");
          current.payout_account = body.payout_account;
        }
        if (body.contact_email !== undefined) {
          if (typeof body.contact_email !== "string") throw new ApiError(400, "invalid_request");
          current.contact_email = body.contact_email;
        }
        if (body.fee_mode !== undefined) {
          if (body.fee_mode !== "absorb" && body.fee_mode !== "pass_to_customer")
            throw new ApiError(400, "invalid_fee_mode");
          current.fee_mode = body.fee_mode;
        }
        if (body.payout !== undefined) {
          const payout = body.payout as { schedule?: unknown; destination?: unknown };
          const schedule = payout.schedule ?? current.payout?.schedule ?? "manual";
          if (
            schedule !== "manual" &&
            schedule !== "each_payment" &&
            schedule !== "daily" &&
            schedule !== "weekly" &&
            schedule !== "monthly"
          )
            throw new ApiError(400, "invalid_payout_schedule");
          if (
            payout.destination !== undefined &&
            payout.destination !== null &&
            typeof payout.destination !== "string"
          )
            throw new ApiError(400, "invalid_payout_destination");
          current.payout = {
            schedule,
            destination:
              payout.destination === undefined
                ? (current.payout?.destination ?? null)
                : (payout.destination as string | null),
          };
        }
        current.updated_at = nowIso(this.clock);
        try {
          this.store.saveBusiness(current);
        } catch (error) {
          if (error instanceof Error && error.message === "username_taken")
            throw new ApiError(409, "username_taken", "Username is already taken");
          throw error;
        }
      }
      return { status: 200, body: this.businessView(current) };
    }
    if (path === "/v1/business/username_available" && method === "GET") {
      const context = this.requireAuth(request);
      const current = this.business(context.accountId);
      const candidate = normalizeUsername(request.query.get("u") ?? "");
      if (current.username !== null && candidate === current.username) {
        return { status: 200, body: { available: true, reason: "available" } };
      }
      const taken = this.store.usernameTaken(candidate, this.clock().getTime());
      return {
        status: 200,
        body: usernameAvailability(candidate, context.accountId, taken),
      };
    }
    if (path === "/v1/webhook_event_types" && method === "GET") {
      this.requireAuth(request);
      const types = [
        ...CORE_WEBHOOK_EVENT_TYPES,
        ...this.modules.flatMap((module) => module.eventTypes ?? []),
      ];
      return { status: 200, body: { types: [...new Set(types)].sort() } };
    }
    if (path === "/v1/payout/estimate" && method === "GET") {
      this.requireAuth(request);
      if (this.deps.payoutEstimator === undefined)
        throw new ApiError(503, "payout_estimate_unavailable");
      const destination = request.query.get("destination") ?? "";
      if (destination === "") throw new ApiError(400, "invalid_request", "destination required");
      return { status: 200, body: await this.deps.payoutEstimator.estimate(destination) };
    }
    if (path === "/v1/fee_preview" && method === "GET") {
      const context = this.requireAuth(request);
      const business = this.business(context.accountId);
      const subtotal = request.query.get("subtotal_usd") ?? "";
      if (!/^\d+(?:\.\d{1,2})?$/.test(subtotal))
        throw new ApiError(400, "invalid_request", "subtotal_usd required");
      const mode = (request.query.get("fee_mode") ?? business.fee_mode ?? "absorb") as FeeMode;
      if (mode !== "absorb" && mode !== "pass_to_customer")
        throw new ApiError(400, "invalid_fee_mode");
      return { status: 200, body: feePreview(subtotal, mode) };
    }
    if (path === "/v1/business/storage_credit" && method === "GET") {
      const context = this.requireAuth(request);
      const credit = await this.deps.contract.storageCredit(context.accountId);
      let sponsor: Awaited<ReturnType<NonNullable<ContractPort["sponsorStatus"]>>> | undefined;
      try {
        sponsor = await this.deps.contract.sponsorStatus?.(context.accountId);
      } catch {
        console.warn("sponsor_status unavailable; returning own credit only");
        sponsor = undefined;
      }
      return {
        status: 200,
        body: {
          balance: credit.balance,
          account_id: context.accountId,
          contract_id: this.deps.config.rootAccount,
          amount: credit.amount,
          method: "deposit_storage_credit",
          ...(sponsor === undefined
            ? {}
            : {
                sponsor: {
                  pool: sponsor.pool,
                  cap: sponsor.cap,
                  used: sponsor.used,
                  remaining: Math.max(0, sponsor.cap - sponsor.used),
                },
              }),
        },
      };
    }

    if (path === "/v1/invoices" && method === "POST") {
      this.requireScope(this.requireAuth(request), "invoices:write");
      return this.withIdempotency(request, () => this.createInvoice(request));
    }
    if (path === "/v1/invoices" && method === "GET") {
      const context = this.requireAuth(request);
      this.requireScope(context, "invoices:read");
      return {
        status: 200,
        body: {
          data: await this.liveInvoices(this.store.listInvoices(context.accountId)),
        },
      };
    }

    const invoiceMatch = /^\/v1\/invoices\/([^/]+)(?:\/(send|receipts|pdf|open_quotes))?$/.exec(
      path,
    );
    if (invoiceMatch !== null) {
      const invoiceId = invoiceMatch[1];
      const action = invoiceMatch[2];
      if (invoiceId === undefined) throw new ApiError(404, "invoice_not_found");
      if (action === undefined && method === "GET") {
        const context = this.requireAuth(request);
        this.requireScope(context, "invoices:read");
        const invoice = this.ownInvoice(context.accountId, invoiceId);
        const claim = await this.deps.contract.claim(invoice.token_id);
        return {
          status: 200,
          body: {
            invoice: {
              ...this.invoiceView(invoice),
              ...(typeof claim.status === "string" ? { status: claim.status as never } : {}),
              outstanding:
                typeof claim.amount_due === "string" ? outstandingOf(claim) : invoice.outstanding,
              paid_total: paidTotalOf(claim, invoice.paid_total),
            },
            claim: { ...claim, kind_rules: kindRules(Number(claim.kind ?? 0)) },
          },
        };
      }
      if (action === "send" && method === "POST") {
        // Nothing sends email yet. Say so: never answer "sent" for a message that was not sent.
        const context = this.requireAuth(request);
        this.requireScope(context, "invoices:write");
        this.ownInvoice(context.accountId, invoiceId);
        throw new ApiError(
          501,
          "email_not_available",
          "Email sending is not available yet. Share the pay link or the QR code instead.",
        );
      }
      if (action === "receipts" && method === "GET") {
        const context = this.requireAuth(request);
        this.requireScope(context, "receipts:read");
        const invoice = this.ownInvoice(context.accountId, invoiceId);
        const receipts =
          this.deps.indexer === undefined
            ? this.store.listReceipts(invoice.token_id)
            : await this.deps.indexer.listReceipts(context.accountId, invoice.token_id);
        return { status: 200, body: { data: receipts } };
      }
      if (action === "pdf" && method === "GET") {
        const context = this.requireAuth(request);
        this.requireScope(context, "invoices:read");
        const invoice = this.ownInvoice(context.accountId, invoiceId);
        return {
          status: 200,
          body: {
            invoice_id: invoice.id,
            token_id: invoice.token_id,
            filename: `${invoice.invoice_number}.pdf`,
            content_type: "application/pdf",
            content_base64: renderInvoicePdfBase64(
              invoice.terms,
              invoice.terms_hash,
              invoice.created_at,
              invoice.line_items,
            ),
            sha256: invoice.terms_hash,
            generated_at: nowIso(this.clock),
          },
        };
      }
      if (action === "open_quotes" && method === "GET") {
        const context = this.requireAuth(request);
        this.requireScope(context, "invoices:read");
        const invoice = this.ownInvoice(context.accountId, invoiceId);
        return { status: 200, body: { data: this.store.getOpenQuotes(invoice.token_id) } };
      }
    }

    const recurringMatch = /^\/v1\/recurring_invoices(?:\/([^/]+))?$/.exec(path);
    if (recurringMatch !== null) {
      const context = this.requireAuth(request);
      this.requireScope(context, method === "GET" ? "invoices:read" : "invoices:write");
      const run = async (): Promise<ApiResponse> =>
        handleRecurring({
          method,
          id: recurringMatch[1],
          body: request.body,
          accountId: context.accountId,
          store: this.recurring,
          clock: this.clock,
        });
      return method === "POST" ? this.withIdempotency(request, run) : run();
    }

    if (path === "/v1/pay/sessions" && method === "POST") {
      return this.withIdempotency(request, async () => {
        const context = this.requireAuth(request, true);
        if (context.kind === "publishable") {
          this.requireScope(context, "pay_sessions:create");
        }
        const body = (request.body ?? {}) as {
          token_id?: string;
          route_id?: string;
          amount_usd?: string;
          refund_to?: string;
          deadline_seconds?: number;
        };
        if (body.token_id === undefined || body.route_id === undefined) {
          throw new ApiError(400, "invalid_request", "token_id and route_id required");
        }
        if (body.refund_to === undefined || body.refund_to === "") {
          throw new ApiError(400, "invalid_refund_address");
        }
        try {
          validateRefundAddress(getRoute(body.route_id, this.routes).originChain, body.refund_to);
        } catch (error) {
          if (error instanceof AddressError) throw new ApiError(400, error.code, error.message);
          throw new ApiError(400, "unknown_route");
        }
        const session = await this.quotes.createSession({
          tokenId: body.token_id,
          routeId: body.route_id,
          amountUsd: body.amount_usd,
          refundTo: body.refund_to,
          deadlineSeconds: body.deadline_seconds,
        });
        this.store.savePaySession(session);
        const quotes = this.store.getOpenQuotes(session.token_id);
        quotes.push({
          quote_id: session.quote_id,
          deposit_address: session.deposit_address,
          deadline_requested: session.deadline_requested,
          deadline: session.deadline,
          refund_to: body.refund_to,
          route_id: session.route_id,
          expired: false,
        });
        this.store.saveOpenQuotes(session.token_id, quotes);
        await this.deps.pokeIndexer?.().catch(() => undefined);
        return { status: 201, body: session };
      });
    }
    const paySessionsOfMatch = /^\/v1\/pay\/claims\/([^/]+)\/sessions$/.exec(path);
    if (paySessionsOfMatch !== null && method === "GET") {
      const invoice = this.invoiceBy(paySessionsOfMatch[1] ?? "");
      return { status: 200, body: { data: this.store.listPaySessions(invoice.token_id) } };
    }
    const paySessionMatch = /^\/v1\/pay\/sessions\/([^/]+)$/.exec(path);
    if (paySessionMatch !== null && method === "GET") {
      const session = this.store.getPaySession(paySessionMatch[1] ?? "");
      if (session === undefined) throw new ApiError(404, "pay_session_not_found");
      // The payer's page polls this. The truth is the provider's word about this deposit address;
      // a price that never received money must never look paid, whatever the claim says.
      let status: string = session.status;
      let swap: Record<string, unknown> = { status: "PENDING_DEPOSIT" };
      try {
        const live = await this.quotes.status(session.deposit_address);
        if (live !== undefined) {
          status = paymentStatusOf(live.status);
          swap = {
            status: live.status,
            ...(live.depositedAmount === undefined
              ? {}
              : { deposited_amount: live.depositedAmount }),
            origin_chain_tx_hashes: live.originChainTxHashes ?? [],
            destination_chain_tx_hashes: live.destinationChainTxHashes ?? [],
            near_tx_hashes: live.nearTxHashes ?? [],
          };
        }
      } catch {
        /* the provider is slow: keep the stored status */
      }
      return {
        status: 200,
        body: {
          id: session.id,
          status,
          swap_details: swap,
          updated_at: nowIso(this.clock),
        },
      };
    }
    const publicClaimMatch = /^\/v1\/pay\/claims\/([^/]+)$/.exec(path);
    if (publicClaimMatch !== null && method === "GET") {
      const invoice = this.invoiceBy(publicClaimMatch[1] ?? "");
      const claim = await this.deps.contract.claim(invoice.token_id);
      return {
        status: 200,
        body: {
          token_id: invoice.token_id,
          invoice_number: invoice.invoice_number,
          issuer_legal_name: invoice.issuer_legal_name,
          debtor_legal_name: invoice.debtor_legal_name,
          line_items: invoice.line_items ?? [],
          claim_account: invoice.claim_account,
          terms_hash: invoice.terms_hash,
          amount_due: invoice.amount_due,
          amount_usd: invoice.amount_usd,
          outstanding:
            typeof claim.amount_due === "string" ? outstandingOf(claim) : invoice.amount_due,
          status: typeof claim.status === "string" ? (claim.status as never) : invoice.status,
          due_date: invoice.due_date,
          pay_link: invoice.pay_link,
          terms: invoice.terms,
          routes: allowedRoutes(this.routes).map((route) => ({
            id: route.id,
            origin_chain: route.originChain,
            payer_asset: route.payerAsset,
            origin_asset_id: route.originAssetId,
            origin_decimals: route.originDecimals,
            origin_contract: route.originContract,
            swap_type: route.swapType,
            destination_asset_id: route.destinationAssetId,
            evm_chain_id: route.evmChainId,
            rpc_var: route.rpcVar,
            part_b: route.partB,
          })),
        },
      };
    }

    const ackMatch = /^\/v1\/ack\/([^/]+)(?:\/(evm))?$/.exec(path);
    if (ackMatch !== null) {
      const tokenId = ackMatch[1] ?? "";
      const action = ackMatch[2];
      if (method === "GET" && action === undefined) {
        const invoice = this.invoiceBy(tokenId);
        return {
          status: 200,
          body: {
            token_id: invoice.token_id,
            invoice_number: invoice.invoice_number,
            claim_account: invoice.claim_account,
            debtor: invoice.debtor ?? { Near: invoice.debtor_legal_name },
            terms_hash: invoice.terms_hash,
            amount_due: invoice.amount_due,
            amount_usd: invoice.amount_usd,
            line_items: invoice.line_items ?? [],
            due_date: Date.parse(invoice.terms.due_date) / 1000,
            status: invoice.status,
            terms: invoice.terms,
            domain: {
              name: "Openrail",
              version: "1",
              chain_ids: [1, 8453, 42161, 10, 137, 56],
              verifying_contract: "0x" + "0".repeat(40),
            },
            primary_type: "Acknowledge",
            message: {
              kind: "OPENRAIL_ACK_V1",
              root_contract: this.deps.config.rootAccount,
              token_id: invoice.token_id,
              terms_hash: invoice.terms_hash,
              amount_due: invoice.amount_due,
              due_date: Date.parse(invoice.terms.due_date) / 1000,
            },
          },
        };
      }
      if (method === "POST" && action === "evm") {
        return this.withIdempotency(request, async () => {
          const body = (request.body ?? {}) as { chain_id?: number; signature?: string };
          if (body.chain_id === undefined || body.signature === undefined) {
            throw new ApiError(400, "invalid_request", "chain_id and signature required");
          }
          if (![1, 8453, 42161, 10, 137, 56].includes(body.chain_id)) {
            throw new ApiError(422, "unsupported_chain");
          }
          const result = await this.deps.issuer.acknowledgeEvm({
            tokenId,
            chainId: body.chain_id,
            signature: body.signature,
          });
          return {
            status: 200,
            body: { token_id: tokenId, ack: result.ack, tx_hash: result.txHash },
          };
        });
      }
    }

    if (path === "/v1/cashout/quote" && method === "POST") {
      return this.withIdempotency(request, async () => {
        const context = this.requireAuth(request);
        const body = (request.body ?? {}) as {
          amount?: string;
          destination_chain?: string;
          address?: string;
        };
        if (!body.amount || !body.destination_chain || !body.address) {
          throw new ApiError(
            400,
            "invalid_request",
            "amount, destination_chain and address required",
          );
        }
        const quote = await this.deps.cashout.quote({
          amount: body.amount,
          destinationChain: body.destination_chain,
          address: body.address,
          refundTo: context.accountId,
        });
        await this.deps.pokeIndexer?.().catch(() => undefined);
        return { status: 201, body: quote };
      });
    }

    if (path === "/v1/statements" && method === "GET") {
      const context = this.requireAuth(request);
      const format = request.query.get("format") === "pdf" ? "pdf" : "csv";
      const tokenId = request.query.get("token_id") ?? undefined;
      if (this.deps.indexer !== undefined) {
        return {
          status: 200,
          body: await this.deps.indexer.getStatement(context.accountId, {
            ...(request.query.get("from") === null
              ? {}
              : { from: request.query.get("from") ?? undefined }),
            ...(request.query.get("to") === null
              ? {}
              : { to: request.query.get("to") ?? undefined }),
            format,
            ...(tokenId === undefined ? {} : { tokenId }),
          }),
        };
      }
      const invoices = this.store
        .listInvoices(context.accountId)
        .filter((invoice) => tokenId === undefined || invoice.token_id === tokenId);
      const csv = [
        "invoice_number,amount_usd,due_date,status",
        ...invoices.map(
          (invoice) =>
            `${invoice.invoice_number},${invoice.amount_usd},${invoice.due_date},${invoice.status}`,
        ),
      ].join("\n");
      const content =
        format === "csv"
          ? csv
          : renderInvoicePdfBase64(
              invoices[0]?.terms ??
                buildTerms({
                  invoice_number: "STATEMENT",
                  issuer_legal_name: "Openrail",
                  issuer_account: this.deps.config.rootAccount,
                  debtor_legal_name: "",
                  debtor_key: "",
                  amount_usd: "0.00",
                  due_date: "2026-01-01T00:00:00Z",
                  line_items_sha256: "0x" + "0".repeat(64),
                  claim_account: this.deps.config.rootAccount,
                  pay_link: `${this.deps.config.payBaseUrl}/statement`,
                }),
              "0x" + "0".repeat(64),
            );
      return {
        status: 200,
        body: {
          format,
          filename: `statement-${format}`,
          content_type: format === "csv" ? "text/csv" : "application/pdf",
          content_base64: format === "csv" ? Buffer.from(csv).toString("base64") : content,
          sha256: sha256Hex0x(format === "csv" ? csv : content),
          generated_at: nowIso(this.clock),
        },
      };
    }

    if (path === "/v1/webhook_endpoints") {
      const context = this.requireAuth(request);
      this.requireScope(context, "webhooks:write");
      if (method === "GET") {
        return {
          status: 200,
          body: {
            data: this.store.listWebhookEndpoints(context.accountId).map((endpoint) => ({
              id: endpoint.id,
              url: endpoint.url,
              events: endpoint.events,
              created_at: nowIso(this.clock),
            })),
          },
        };
      }
      if (method === "POST") {
        return this.withIdempotency(request, async () => {
          const body = (request.body ?? {}) as { url?: string; events?: string[] };
          if (body.url === undefined || body.events === undefined) {
            throw new ApiError(400, "invalid_request", "url and events required");
          }
          try {
            await (this.deps.webhookUrlValidator ?? validateWebhookUrl)(body.url);
          } catch (error) {
            if (error instanceof UnsafeWebhookUrl) {
              throw new ApiError(400, "invalid_webhook_url", error.message);
            }
            throw error;
          }
          const endpoint: WebhookEndpointRecord & { secret: string } = {
            id: id("whe"),
            url: body.url,
            secret: `whsec_${randomBytes(24).toString("base64url")}`,
            events: body.events,
            created_at: nowIso(this.clock),
          };
          this.store.saveWebhookEndpoint(context.accountId, endpoint);
          void context;
          return {
            status: 201,
            body: {
              id: endpoint.id,
              url: endpoint.url,
              secret: endpoint.secret,
              events: endpoint.events,
              created_at: nowIso(this.clock),
            },
          };
        });
      }
    }
    const webhookMatch = /^\/v1\/webhook_endpoints\/([^/]+)(?:\/(test|deliveries))?$/.exec(path);
    if (webhookMatch !== null) {
      this.requireScope(this.requireAuth(request), "webhooks:write");
      const endpointId = webhookMatch[1] ?? "";
      const action = webhookMatch[2];
      const endpoint = this.store.getWebhookEndpoint(endpointId);
      if (endpoint === undefined) throw new ApiError(404, "webhook_endpoint_not_found");
      if (method === "DELETE" && action === undefined) {
        this.store.deleteWebhookEndpoint(endpointId);
        return { status: 200, body: { id: endpointId, deleted: true } };
      }
      if (method === "POST" && action === "test") {
        return this.withIdempotency(request, async () => {
          const result = await deliverTestWebhook(
            endpoint,
            {
              id: id("evt"),
              type: endpoint.events[0] ?? "invoice.paid",
              created: Math.floor(this.clock().getTime() / 1000),
              data: { test: true },
            },
            {
              ...(this.deps.webhookFetch === undefined
                ? {}
                : { fetchImpl: this.deps.webhookFetch }),
              ...(this.deps.webhookUrlValidator === undefined
                ? {}
                : { validateUrl: this.deps.webhookUrlValidator }),
            },
          );
          return {
            status: 200,
            body: {
              delivered: result.statusCode >= 200 && result.statusCode < 300,
              status_code: result.statusCode,
              event_id: id("evt"),
            },
          };
        });
      }
      if (method === "GET" && action === "deliveries") {
        return { status: 200, body: { data: this.store.listDeliveries(endpointId) } };
      }
    }

    if (path === "/v1/analytics" && method === "GET") {
      this.requireScope(this.requireAuth(request), "invoices:read");
      if (this.deps.indexer === undefined) throw new ApiError(503, "analytics_unavailable");
      return { status: 200, body: await this.deps.indexer.analytics() };
    }

    if (path === "/v1/events" && method === "GET") {
      const context = this.requireAuth(request);
      // The event stream is shared by every merchant: keep only the events of this merchant's own claims.
      const own = new Set(this.store.listInvoices(context.accountId).map((i) => i.token_id));
      const tokenOf = (e: Record<string, unknown>): string | undefined => {
        const data = e.data as { token_id?: unknown } | undefined;
        return typeof data?.token_id === "string" ? data.token_id : undefined;
      };
      if (this.deps.indexer !== undefined) {
        const limit = Number(request.query.get("limit") ?? "50");
        const want = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
        const type = request.query.get("type");
        let after = request.query.get("cursor") ?? undefined;
        const found: Record<string, unknown>[] = [];
        let next: string | null = null;
        // Read the shared stream page by page until there are enough of this merchant's events (bounded).
        for (let page = 0; page < 10 && found.length < want; page += 1) {
          const batch = await this.deps.indexer.listEvents({
            ...(after === undefined ? {} : { after }),
            ...(type === null ? {} : { type: type ?? undefined }),
            limit: 200,
          });
          for (const e of batch.data as Record<string, unknown>[]) {
            const token = tokenOf(e);
            if (token !== undefined && own.has(token)) found.push(e);
          }
          next = batch.next_cursor ?? null;
          if (next === null) break;
          after = next;
        }
        return { status: 200, body: { data: found.slice(0, want), next_cursor: next } };
      }
      return {
        status: 200,
        body: {
          data: this.store.listEvents().filter((e) => {
            const token = tokenOf(e);
            return token !== undefined && own.has(token);
          }),
        },
      };
    }

    const receiptJsonMatch = /^\/v1\/receipts\/([^/]+)\.json$/.exec(path);
    if (receiptJsonMatch !== null && method === "GET") {
      const bookingTxHash = receiptJsonMatch[1] ?? "";
      const receipt =
        this.deps.indexer === undefined
          ? this.store.getReceipt(bookingTxHash)
          : await this.deps.indexer.getReceipt(bookingTxHash);
      if (receipt === undefined) throw new ApiError(404, "receipt_not_found");
      const tokenId = String(receipt.token_id ?? "");
      const invoice = this.store.getInvoice(tokenId);
      const business =
        invoice === undefined ? undefined : this.store.getBusiness(invoice.issuer_id);
      const feeLine = invoice?.line_items?.find(
        (item) => item.description === PROCESSING_FEE_DESCRIPTION,
      );
      const claimAccount = `${tokenId}.${this.deps.config.rootAccount}`;
      const nearHashes = Array.isArray(receipt.near_tx_hashes)
        ? (receipt.near_tx_hashes as unknown[])
        : [];
      const body = canonicalize({
        receipt_id: String(receipt.id ?? `rcpt_${bookingTxHash}`),
        paid_at: String(receipt.time ?? ""),
        invoice_number: invoice?.invoice_number ?? tokenId,
        order_ref: invoice?.recurring_id ?? tokenId,
        business_name: invoice?.issuer_legal_name ?? null,
        business_username: business?.username ?? null,
        buyer_name: invoice?.debtor_legal_name ?? null,
        amount_usd: invoice?.amount_usd ?? null,
        paid_amount: String(receipt.amount ?? ""),
        paid_asset: String(receipt.asset ?? ""),
        network: receipt.origin_tx ?? null,
        fee_usd: feeLine?.amount_usd ?? "0.00",
        payer_tx: receipt.origin_tx ?? null,
        near_tx: nearHashes[0] ?? bookingTxHash,
        claim_account: claimAccount,
        terms_fingerprint: invoice?.terms_hash ?? String(receipt.terms_hash ?? ""),
        verify_command: `openrail-verify claim ${claimAccount} --terms-hash ${invoice?.terms_hash ?? String(receipt.terms_hash ?? "")}`,
      }) as Record<string, unknown>;
      return { status: 200, body };
    }

    const receiptMatch = /^\/v1\/receipts\/([^/]+)$/.exec(path);
    if (receiptMatch !== null && method === "GET") {
      const bookingTxHash = receiptMatch[1] ?? "";
      const receipt =
        this.deps.indexer === undefined
          ? this.store.getReceipt(bookingTxHash)
          : await this.deps.indexer.getReceipt(bookingTxHash);
      if (receipt === undefined) throw new ApiError(404, "receipt_not_found");
      return {
        status: 200,
        body: {
          receipt,
          verify_url: `${this.deps.config.payBaseUrl}/r/${bookingTxHash}`,
          claim_account: `${String(receipt.token_id ?? "")}.${this.deps.config.rootAccount}`,
        },
      };
    }

    if (path === "/v1/payments" && method === "GET") {
      const context = this.requireAuth(request);
      this.requireScope(context, "payments:read");
      return {
        status: 200,
        body: {
          data: this.store
            .listPayments(context.accountId)
            .filter((payment) => payment.issuer_id === context.accountId),
        },
      };
    }

    const paymentMatch = /^\/v1\/payments\/([^/]+)$/.exec(path);
    if (paymentMatch !== null && method === "GET") {
      const context = this.requireAuth(request);
      this.requireScope(context, "payments:read");
      const payment = this.store.getPayment(paymentMatch[1] ?? "");
      if (payment === undefined || payment.issuer_id !== context.accountId)
        throw new ApiError(404, "payment_not_found");
      return { status: 200, body: payment };
    }

    for (const module of this.modules) {
      const response = await module.route?.(request, this.moduleContext);
      if (response !== undefined) return response;
    }

    throw new ApiError(404, "not_found");
  }

  /** What a module may use: core helpers, never core internals. */
  get moduleContext(): ApiModuleContext {
    return {
      config: this.deps.config,
      contract: this.deps.contract,
      store: this.store,
      docs: this.docs,
      issuer: this.deps.issuer,
      clock: this.clock,
      requireAuth: (request, allowPublishable) => this.requireAuth(request, allowPublishable),
      requireScope: (context, scope) => this.requireScope(context, scope),
      withIdempotency: (request, run) => this.withIdempotency(request, run),
      view: async (methodName, args) => {
        if (this.deps.contract.view === undefined)
          throw new ApiError(503, "contract_view_unavailable");
        return this.deps.contract.view(methodName, args);
      },
    };
  }

  private async createInvoice(request: ApiRequest): Promise<ApiResponse> {
    const context = this.requireAuth(request);
    const invoice = await this.issueInvoice(context.accountId, request.body);
    return { status: 201, body: invoice };
  }

  /**
   * Builds the terms, issues the claim through `issue_for` and stores the invoice. Used by
   * `POST /v1/invoices` and by the recurring-invoice scheduler.
   */
  private issueTail: Promise<void> = Promise.resolve();

  async issueInvoice(
    accountId: string,
    input: unknown,
    options: { recurringId?: string } = {},
  ): Promise<InvoiceRecord> {
    const body = (input ?? {}) as {
      invoice_number?: string;
      issuer_legal_name?: string;
      debtor_legal_name?: string;
      debtor_key?: string;
      amount_usd?: string;
      due_date?: string;
      line_items?: unknown;
      line_items_sha256?: string;
      fee_mode?: unknown;
      pay_link?: string;
      assignment_agreement_sha256?: string;
      clauses?: string[];
    };
    for (const field of [
      "invoice_number",
      "issuer_legal_name",
      "debtor_legal_name",
      "debtor_key",
      "amount_usd",
      "due_date",
    ] as const) {
      if (body[field] === undefined)
        throw new ApiError(400, "invalid_request", `${field} required`);
    }
    const business = this.business(accountId);
    if (business.username === null) {
      throw new ApiError(
        409,
        "username_required",
        "A username is required before issuing an invoice.",
      );
    }
    const invoiceId = id("inv");
    const username = business.username;
    const ref = refOf(invoiceId);
    const labels = this.deps.config.claimLabels === true;
    const feeMode = (body.fee_mode ?? business.fee_mode ?? "absorb") as FeeMode;
    if (feeMode !== "absorb" && feeMode !== "pass_to_customer")
      throw new ApiError(400, "invalid_fee_mode");
    let feeResult: ReturnType<typeof resolveFee>;
    try {
      feeResult = resolveFee(
        twoDecimals(Number(body.amount_usd)),
        normalizeLineItems(body.line_items ?? []),
        feeMode,
      );
    } catch {
      throw new ApiError(400, "invalid_request", "line_items must be valid rows");
    }
    const itemsHash = lineItemsFingerprint(feeResult.items);
    const label = labels ? claimLabelFor(username, ref) : undefined;
    const knownClaimAccount =
      label === undefined ? undefined : `${label}.${this.deps.config.rootAccount}`;
    // The terms hash binds the claim account, which is only known from the id the issuer predicts. Concurrent
    // requests would predict the same id, so they go one at a time; a prediction that turns out wrong (an
    // earlier mint failed after taking its id) is retried once with the corrected count.
    const run = this.issueTail.then(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const prepared = await this.deps.issuer.prepareIssue(accountId);
        const claimAccount = knownClaimAccount ?? prepared.claimAccount;
        if (claimAccount === undefined) {
          throw new ApiError(
            502,
            "issuer_outdated",
            "the issuer service did not report the next claim account",
          );
        }
        if (!labels && prepared.tokenId === undefined) {
          throw new ApiError(
            502,
            "issuer_outdated",
            "the issuer service did not report the next claim id",
          );
        }
        if (prepared.storageCredit !== undefined && prepared.amount !== undefined) {
          if (
            BigInt(prepared.storageCredit) < BigInt(prepared.amount) &&
            prepared.sponsored !== true
          ) {
            const remaining = prepared.sponsoredRemaining ?? 0;
            throw new ApiError(
              402,
              "insufficient_storage_credit",
              `Storage credit is ${prepared.storageCredit} yoctoNEAR and an invoice needs ${prepared.amount}. ` +
                `Deposit storage credit from ${business.account_id} to ${prepared.account ?? "the root contract"} first. ` +
                `${remaining} sponsored invoice${remaining === 1 ? "" : "s"} remain.`,
            );
          }
        }
        const terms = buildTerms({
          invoice_number: body.invoice_number as string,
          issuer_legal_name: body.issuer_legal_name as string,
          issuer_account: business.account_id,
          debtor_legal_name: body.debtor_legal_name as string,
          debtor_key: body.debtor_key as string,
          amount_usd: feeResult.amountUsd,
          due_date: dateToUtc(body.due_date as string),
          line_items_sha256: itemsHash,
          claim_account: claimAccount,
          pay_link: body.pay_link ?? payLink(this.deps.config.payBaseUrl, username, ref),
          assignment_agreement_sha256: body.assignment_agreement_sha256,
          clauses: [...CORE_CLAUSES, ...(body.clauses ?? [])],
        });
        const hash = termsHash(terms);
        const amountDue = usdToBaseUnits(Number(terms.amount_usd), 6).toString();
        const debtor = parseDebtor(body.debtor_key);
        try {
          await this.deps.issuer.issueFor({
            business: business.account_id,
            kind: 0,
            debtor,
            termsHash: hash,
            amountDue,
            dueDate: Math.floor(Date.parse(terms.due_date) / 1000),
            ...(labels
              ? { claimLabel: label as string }
              : { expectedTokenId: prepared.tokenId as string }),
          });
        } catch (error) {
          if (
            !labels &&
            attempt < 2 &&
            error instanceof ApiError &&
            error.code === "token_id_mismatch"
          )
            continue;
          throw error;
        }
        return {
          prepared,
          hash,
          debtor,
          terms,
          amountDue,
          tokenId: label ?? (prepared.tokenId as string),
        };
      }
    });
    this.issueTail = run.then(
      () => undefined,
      () => undefined,
    );
    const { hash, debtor, terms, amountDue, tokenId } = await run;
    const invoice: InvoiceRecord = {
      id: invoiceId,
      token_id: tokenId,
      claim_account: knownClaimAccount ?? `${tokenId}.${this.deps.config.rootAccount}`,
      status: "Issued",
      issuer_id: business.account_id,
      owner_id: business.account_id,
      debtor,
      terms_hash: hash,
      amount_due: amountDue,
      outstanding: amountDue,
      paid_total: "0",
      amount_usd: terms.amount_usd,
      due_date: terms.due_date.slice(0, 10),
      invoice_number: terms.invoice_number,
      issuer_legal_name: terms.issuer_legal_name,
      debtor_legal_name: terms.debtor_legal_name,
      pay_link: terms.pay_link,
      ack_url: ackLink(this.deps.config.payBaseUrl, username, ref),
      created_at: nowIso(this.clock),
      created_block: 0,
      terms,
      line_items: feeResult.items,
      fee_mode: feeMode,
      ...(options.recurringId === undefined ? {} : { recurring_id: options.recurringId }),
    };
    this.store.saveInvoice(invoice);
    return invoice;
  }
}
