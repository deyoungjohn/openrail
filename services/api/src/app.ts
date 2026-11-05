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
import { deliverTestWebhook, type WebhookEndpointRecord } from "./webhooks.js";
import { UnsafeWebhookUrl, validateWebhookUrl } from "./webhook-url.js";

export interface ApiConfig {
  rootAccount: string;
  recipient: string;
  payBaseUrl: string;
}

export interface ContractPort {
  claim(tokenId: string): Promise<Record<string, unknown> & { kind: number }>;
  storageCredit(accountId: string): Promise<{ balance: string; amount: string }>;
}

export interface IssuerPort {
  prepareIssue(accountId: string): Promise<{
    tokenId: string;
    claimAccount: string;
    /** `storage_credit_of(business)` and the deposit one invoice needs, in yoctoNEAR (when the issuer reports them). */
    storageCredit?: string;
    amount?: string;
    /** The account the business deposits storage credit to. */
    account?: string;
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

export interface CashoutPort {
  quote(request: {
    amount: string;
    destinationChain: string;
    address: string;
  }): Promise<Record<string, unknown>>;
}

export interface BusinessRecord {
  account_id: string;
  legal_name: string;
  payout_account: string;
  contact_email: string;
  created_at: string;
  updated_at: string;
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

  constructor(status: number, code: string, message = code, rule?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.rule = rule;
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

function dateToUtc(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

function stableLineItems(lineItems: unknown): string {
  return sha256Hex0x(JSON.stringify(lineItems));
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
      outstanding: String(claim.outstanding ?? claim.amount_due ?? "0"),
      amountDue: String(claim.amount_due ?? "0"),
      kindRules: kindRules(Number(claim.kind ?? 0)),
    };
  }

  private invoiceBy(idOrToken: string): InvoiceRecord {
    const invoice = this.store.getInvoice(idOrToken);
    if (invoice === undefined) throw new ApiError(404, "invoice_not_found");
    return invoice;
  }

  private invoiceView(invoice: InvoiceRecord): Omit<InvoiceRecord, "terms"> & { terms?: Terms } {
    return invoice;
  }

  private business(accountId: string): BusinessRecord {
    const existing = this.store.getBusiness(accountId);
    if (existing !== undefined) return existing;
    const created: BusinessRecord = {
      account_id: accountId,
      legal_name: accountId,
      payout_account: accountId,
      contact_email: "billing@example.com",
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
        const body = (request.body ?? {}) as Partial<BusinessRecord>;
        Object.assign(current, {
          ...(body.legal_name === undefined ? {} : { legal_name: body.legal_name }),
          ...(body.payout_account === undefined ? {} : { payout_account: body.payout_account }),
          ...(body.contact_email === undefined ? {} : { contact_email: body.contact_email }),
          updated_at: nowIso(this.clock),
        });
      }
      return { status: 200, body: current };
    }
    if (path === "/v1/business/storage_credit" && method === "GET") {
      const context = this.requireAuth(request);
      const credit = await this.deps.contract.storageCredit(context.accountId);
      return {
        status: 200,
        body: {
          balance: credit.balance,
          account_id: context.accountId,
          contract_id: this.deps.config.rootAccount,
          amount: credit.amount,
          method: "deposit_storage_credit",
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
          data: this.store
            .listInvoices(context.accountId)
            .map((invoice) => this.invoiceView(invoice)),
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
        this.requireScope(this.requireAuth(request), "invoices:read");
        const invoice = this.invoiceBy(invoiceId);
        const claim = await this.deps.contract.claim(invoice.token_id);
        return {
          status: 200,
          body: {
            invoice: {
              ...this.invoiceView(invoice),
              outstanding: String(claim.outstanding ?? invoice.outstanding),
              paid_total: String(claim.booked_total ?? invoice.paid_total),
            },
            claim: { ...claim, kind_rules: kindRules(Number(claim.kind ?? 0)) },
          },
        };
      }
      if (action === "send" && method === "POST") {
        return this.withIdempotency(request, async () => {
          this.requireScope(this.requireAuth(request), "invoices:write");
          this.invoiceBy(invoiceId);
          const body = (request.body ?? {}) as { to?: string };
          return {
            status: 200,
            body: { sent: true, to: body.to ?? "debtor@example.com", message_id: id("msg") },
          };
        });
      }
      if (action === "receipts" && method === "GET") {
        const context = this.requireAuth(request);
        this.requireScope(context, "receipts:read");
        const invoice = this.invoiceBy(invoiceId);
        const receipts =
          this.deps.indexer === undefined
            ? this.store.listReceipts(invoice.token_id)
            : await this.deps.indexer.listReceipts(context.accountId, invoice.token_id);
        return { status: 200, body: { data: receipts } };
      }
      if (action === "pdf" && method === "GET") {
        this.requireScope(this.requireAuth(request), "invoices:read");
        const invoice = this.invoiceBy(invoiceId);
        return {
          status: 200,
          body: {
            invoice_id: invoice.id,
            token_id: invoice.token_id,
            filename: `${invoice.invoice_number}.pdf`,
            content_type: "application/pdf",
            content_base64: renderInvoicePdfBase64(invoice.terms, invoice.terms_hash),
            sha256: invoice.terms_hash,
            generated_at: nowIso(this.clock),
          },
        };
      }
      if (action === "open_quotes" && method === "GET") {
        this.requireScope(this.requireAuth(request), "invoices:read");
        const invoice = this.invoiceBy(invoiceId);
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
      // The payer's page polls this: once the claim is paid on chain the price is done, whichever
      // address the money went to. (Before, it said "pending" forever.)
      let status: string = session.status;
      try {
        const claim = await this.deps.contract.claim(session.token_id);
        if (claim.status === "Paid") status = "success";
      } catch {
        /* the chain is slow: keep the stored status */
      }
      return {
        status: 200,
        body: {
          id: session.id,
          status,
          swap_details: { status: "PENDING_DEPOSIT" },
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
          claim_account: invoice.claim_account,
          terms_hash: invoice.terms_hash,
          amount_due: invoice.amount_due,
          amount_usd: invoice.amount_usd,
          outstanding: String(claim.outstanding ?? invoice.amount_due),
          due_date: invoice.due_date,
          status: invoice.status,
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
        this.requireAuth(request);
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
      this.requireAuth(request);
      if (this.deps.indexer !== undefined) {
        const limit = Number(request.query.get("limit") ?? "50");
        return {
          status: 200,
          body: await this.deps.indexer.listEvents({
            ...(request.query.get("cursor") === null
              ? {}
              : { after: request.query.get("cursor") ?? undefined }),
            ...(request.query.get("type") === null
              ? {}
              : { type: request.query.get("type") ?? undefined }),
            limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50,
          }),
        };
      }
      return { status: 200, body: { data: this.store.listEvents() } };
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
          claim_account: String(receipt.token_id ?? "") + ".openrail.near",
        },
      };
    }

    if (path === "/v1/payments" && method === "GET") {
      const context = this.requireAuth(request);
      this.requireScope(context, "payments:read");
      return { status: 200, body: { data: this.store.listPayments(context.accountId) } };
    }

    const paymentMatch = /^\/v1\/payments\/([^/]+)$/.exec(path);
    if (paymentMatch !== null && method === "GET") {
      this.requireScope(this.requireAuth(request), "payments:read");
      const payment = this.store.getPayment(paymentMatch[1] ?? "");
      if (payment === undefined) throw new ApiError(404, "payment_not_found");
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
      store: this.store,
      docs: this.docs,
      issuer: this.deps.issuer,
      clock: this.clock,
      requireAuth: (request, allowPublishable) => this.requireAuth(request, allowPublishable),
      requireScope: (context, scope) => this.requireScope(context, scope),
      withIdempotency: (request, run) => this.withIdempotency(request, run),
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
    // The terms hash binds the claim account, which is only known from the id the issuer predicts. Concurrent
    // requests would predict the same id, so they go one at a time; a prediction that turns out wrong (an
    // earlier mint failed after taking its id) is retried once with the corrected count.
    const run = this.issueTail.then(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const prepared = await this.deps.issuer.prepareIssue(accountId);
        if (!prepared.tokenId || !prepared.claimAccount) {
          throw new ApiError(
            502,
            "issuer_outdated",
            "the issuer service did not report the next claim id",
          );
        }
        if (prepared.storageCredit !== undefined && prepared.amount !== undefined) {
          if (BigInt(prepared.storageCredit) < BigInt(prepared.amount)) {
            throw new ApiError(
              402,
              "insufficient_storage_credit",
              `Storage credit is ${prepared.storageCredit} yoctoNEAR and an invoice needs ${prepared.amount}. ` +
                `Deposit storage credit from ${business.account_id} to ${prepared.account ?? "the root contract"} first.`,
            );
          }
        }
        const terms = buildTerms({
          invoice_number: body.invoice_number as string,
          issuer_legal_name: body.issuer_legal_name as string,
          issuer_account: business.account_id,
          debtor_legal_name: body.debtor_legal_name as string,
          debtor_key: body.debtor_key as string,
          amount_usd: twoDecimals(Number(body.amount_usd)),
          due_date: dateToUtc(body.due_date as string),
          line_items_sha256: body.line_items_sha256 ?? stableLineItems(body.line_items ?? []),
          claim_account: prepared.claimAccount,
          pay_link: body.pay_link ?? `${this.deps.config.payBaseUrl}/c/${prepared.tokenId}`,
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
            expectedTokenId: prepared.tokenId,
          });
        } catch (error) {
          if (attempt < 2 && error instanceof ApiError && error.code === "token_id_mismatch")
            continue;
          throw error;
        }
        return { prepared, hash, debtor, terms, amountDue };
      }
    });
    this.issueTail = run.then(
      () => undefined,
      () => undefined,
    );
    const { prepared, hash, debtor, terms, amountDue } = await run;
    const invoice: InvoiceRecord = {
      id: id("inv"),
      token_id: prepared.tokenId,
      claim_account: prepared.claimAccount,
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
      ack_url: `${this.deps.config.payBaseUrl}/ack/${prepared.tokenId}`,
      created_at: nowIso(this.clock),
      created_block: 0,
      terms,
      ...(options.recurringId === undefined ? {} : { recurring_id: options.recurringId }),
    };
    this.store.saveInvoice(invoice);
    return invoice;
  }
}
