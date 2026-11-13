/**
 * Checkouts (`/v1/checkouts`), their public view (`/v1/public/checkouts/:id`), their webhook
 * events (`checkout.created`, `checkout.paid`, `checkout.partial`, `checkout.paid_late`,
 * `checkout.accepted`, `checkout.refund_started`), and the late-payment wallet actions
 * (`accept_late`, `refund_quote`).
 *
 * Status (`pending`, `partial`, `paid`, `late`, `accepted`, `refunded`, `expired`), `outstanding`
 * and `paid_total` are read from the claim on chain, never from the record written at creation.
 * The API never signs for the merchant: late-payment endpoints return the call the merchant's
 * wallet signs, and `refund_quote` takes the refund destination from the claim's recorded quote
 * log, never from the request.
 */
import { createHash } from "node:crypto";
import {
  allowedRoutes,
  createOneClickClientFromEnv,
  defaultSettlementAsset,
  loadRoutes,
  type RouteFile,
} from "@openrail/shared";
import {
  ApiError,
  outstandingOf,
  paidTotalOf,
  plainText,
  type ApiRequest,
  type ApiResponse,
  type BusinessRecord,
} from "../../app.js";
import type { ApiModuleContext, QuoteWindow } from "../../modules.js";
import type { IndexedEvent } from "../../webhooks.js";
import { sha256Hex0x } from "../../crypto.js";
import { feePreview, resolveFee, type FeeMode } from "../../line-items.js";
import { EMPTY_ITEMS_SHA256, issuerCheckoutPort, type CheckoutPort } from "./checkout-port.js";

const NS_CHECKOUTS = "checkout.checkouts";
/** A checkout that can no longer change: its claim and checkout state, read once and kept for good. */
const NS_SETTLED = "checkout.settled";
/** The last claim and state read of a checkout still in flight, for when the chain cannot be read. */
const NS_LAST = "checkout.last";
/**
 * Late money can still land after expiry (it is booked and held, see the module spec), so an expired,
 * accepted or refunded checkout is kept as settled only this long after its expiry.
 */
const DEFAULT_SETTLE_GRACE_SECONDS = 3600;

interface ChainSnapshot {
  claim: Record<string, unknown>;
  state: ChainCheckoutState | null;
}
const NS_REFS = "checkout.order_refs";
/** One poke per checkout and money status; bounded so a long-lived process keeps no more than 500 ids. */
const POKE_STATUSES = new Set(["paid", "partial", "late", "accepted"]);

const ORDER_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const USD_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;

export type CheckoutStatus =
  | "pending"
  | "partial"
  | "paid"
  | "late"
  | "accepted"
  | "refunded"
  | "expired"
  | "needs_attention"
  /** The chain could not be read just now; the answer is the last copy read (or none yet). */
  | "checking";

export type { FeeMode };

export interface CheckoutItem {
  name: string;
  quantity: number;
  unit_price_usd?: string;
}

export function computeFeeBreakdown(
  subtotalUsd: string,
  mode: FeeMode,
): {
  feeMode: FeeMode;
  subtotalUsd: string;
  feeUsd: string;
  totalUsd: string;
} {
  const preview = feePreview(subtotalUsd, mode);
  return {
    feeMode: preview.fee_mode,
    subtotalUsd: preview.subtotal_usd,
    feeUsd: preview.fee_usd,
    totalUsd: preview.total_usd,
  };
}

export interface StoredCheckout {
  id: string;
  token_id: string;
  claim_account: string;
  account_id: string;
  order_ref: string;
  amount_usd: string;
  amount_due: string;
  expires_at: string;
  expiry: number;
  pay_url: string;
  return_url: string | null;
  cancel_url?: string | null;
  currency?: string;
  amount_cents?: number;
  items_sha256: string;
  created_at: string;
  fee_mode?: FeeMode;
  subtotal_usd?: string;
  fee_usd?: string;
  total_usd?: string;
  /** The store's name for its customer (billing name), shown as the payer in the merchant's dashboard. Optional. */
  customer_name?: string | null;
  /** The store's own order number (WooCommerce order number, Shopify order name). Optional, display only. */
  order_number?: string | null;
}

export interface CheckoutView {
  id: string;
  token_id: string;
  claim_account: string;
  order_ref: string;
  amount_usd: string;
  amount_due: string;
  amount_cents: number;
  currency: string;
  outstanding: string;
  paid_total: string;
  surplus: string;
  status: CheckoutStatus;
  pay_url: string;
  return_url: string | null;
  cancel_url?: string | null;
  expires_at: string;
  created_at: string;
  merchant_name?: string;
  fee_mode: FeeMode;
  subtotal_usd: string;
  fee_usd: string;
  total_usd: string;
}

export interface ChainCheckoutState {
  expiry: number;
  late: boolean;
  refunded: boolean;
  accepted?: boolean;
  held_amount?: string | { 0?: string };
  held?: string;
  flagged?: boolean;
  notified?: string[];
  order_ref: string;
}

export interface LoggedQuote {
  quote_id: string;
  deposit_address: string;
  deadline_requested: number;
  refund_to: string;
  route_id: string;
}

export interface CheckoutChain {
  claim(tokenId: string): Promise<Record<string, unknown>>;
  checkoutState(tokenId: string): Promise<ChainCheckoutState | null>;
  paymentLog(tokenId: string): Promise<LoggedQuote[]>;
}

export interface RefundQuoteInput {
  tokenId: string;
  claimAccount: string;
  refundTo: string;
  routeId: string;
  amount: string;
}

export interface RefundQuote {
  quote_id: string;
  deposit_address: string;
  amount_in: string;
  amount_out: string;
  deadline: string;
  recipient: string;
}

export interface RefundQuotePort {
  quote(input: RefundQuoteInput): Promise<RefundQuote>;
}

export interface CheckoutOptions {
  checkouts?: (context: ApiModuleContext) => CheckoutPort;
  chain?: (context: ApiModuleContext) => CheckoutChain;
  refunds?: (context: ApiModuleContext) => RefundQuotePort;
  /** Seconds after expiry before an expired, accepted or refunded checkout is kept as settled. */
  settleGraceSeconds?: number;
}

function bad(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}

function parseUsd(
  value: unknown,
  field: string,
): { text: string; cents: bigint; baseUnits: string } {
  if (typeof value !== "string" || !USD_RE.test(value)) {
    bad(`${field} must be a positive USD string with at most 2 decimals`);
  }
  const [whole, frac = ""] = value.split(".");
  const cents = BigInt(whole ?? "0") * 100n + BigInt(frac.padEnd(2, "0"));
  if (cents <= 0n) bad(`${field} must be greater than zero`);
  return {
    text: `${whole}.${frac.padEnd(2, "0")}`,
    cents,
    baseUnits: (cents * 10_000n).toString(),
  };
}

function parseHttpsUrl(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") bad(`${field} must be an https URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    bad(`${field} must be a valid URL`);
  }
  if (url.protocol !== "https:") bad(`${field} must use https`);
  return url.toString();
}

function hashItems(value: unknown): string {
  if (value === undefined || value === null) return EMPTY_ITEMS_SHA256;
  if (!Array.isArray(value) || value.length > 100) {
    bad("items must be an array of at most 100 items");
  }
  const clean: CheckoutItem[] = value.map((raw) => {
    if (typeof raw !== "object" || raw === null) bad("each item must be an object");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== "string" || entry.name.trim() === "" || entry.name.length > 200) {
      bad("item.name must be 1..200 characters");
    }
    const qty = entry.quantity;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 1_000_000) {
      bad("item.quantity must be a positive integer");
    }
    const out: CheckoutItem = { name: entry.name.trim(), quantity: qty };
    if (entry.unit_price_usd !== undefined) {
      out.unit_price_usd = parseUsd(entry.unit_price_usd, "item.unit_price_usd").text;
    }
    return out;
  });
  return sha256Hex0x(JSON.stringify(clean));
}

function toBig(value: unknown): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "object" && value !== null) {
    const inner = (value as Record<string, unknown>)["0"];
    if (typeof inner === "string" && /^\d+$/.test(inner)) return BigInt(inner);
  }
  return 0n;
}

function unwrapU128(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "object" && value !== null) {
    const inner = (value as Record<string, unknown>)["0"];
    if (typeof inner === "string" && /^\d+$/.test(inner)) return inner;
  }
  return undefined;
}

function heldAmountOf(state: ChainCheckoutState | null): string | undefined {
  if (state === null) return undefined;
  return unwrapU128(state.held_amount) ?? unwrapU128(state.held);
}

function normaliseClaim(
  claim: Record<string, unknown>,
  stored: StoredCheckout,
): Record<string, unknown> {
  return {
    ...claim,
    amount_due: unwrapU128(claim.amount_due) ?? stored.amount_due,
    booked_total: unwrapU128(claim.booked_total) ?? "0",
    surplus: unwrapU128(claim.surplus) ?? "0",
    credit_total: unwrapU128(claim.credit_total) ?? "0",
    fee_total: unwrapU128(claim.fee_total) ?? "0",
    distributed_total: unwrapU128(claim.distributed_total) ?? "0",
  };
}

function statusOf(
  claim: Record<string, unknown>,
  state: ChainCheckoutState | null,
  stored: StoredCheckout,
  nowSec: number,
): CheckoutStatus {
  if (state?.flagged === true) return "needs_attention";
  if (state?.accepted === true) return "accepted";
  const held = toBig(heldAmountOf(state));
  if (state?.late === true && held > 0n) return "late";
  if (state?.refunded === true) return "refunded";
  const due = toBig(claim.amount_due);
  const paid = toBig(claim.booked_total) - toBig(claim.surplus) + toBig(claim.credit_total);
  if (state?.late === true) {
    if (paid > 0n && toBig(claim.distributed_total) >= paid - toBig(claim.fee_total)) {
      return "accepted";
    }
    return "late";
  }
  if (due > 0n && paid >= due) return "paid";
  if (paid > 0n) return "partial";
  const expiry =
    state?.expiry ?? (typeof claim.due_date === "number" ? claim.due_date : stored.expiry);
  if (nowSec >= expiry) return "expired";
  return "pending";
}

/** A contract that lacks the view answers "no such method": that is "nothing there", not "cannot read". */
function isMissingView(error: unknown): boolean {
  if (error instanceof ApiError && error.code === "contract_view_unavailable") return true;
  const text = error instanceof Error ? error.message : String(error);
  return /MethodNotFound|method .*not found|no such method|CodeDoesNotExist/i.test(text);
}

async function contractView<T>(
  context: ApiModuleContext,
  method: string,
  args: object,
): Promise<T | null> {
  try {
    return ((await context.view(method, args)) as T | null) ?? null;
  } catch (error) {
    if (isMissingView(error)) return null;
    throw error;
  }
}

export function defaultCheckoutChain(context: ApiModuleContext): CheckoutChain {
  return {
    claim: (tokenId) => context.contract.claim(tokenId),
    async checkoutState(tokenId) {
      return contractView<ChainCheckoutState>(context, "checkout_state", { token_id: tokenId });
    },
    async paymentLog(tokenId) {
      const fromChain = await contractView<LoggedQuote[]>(context, "payment_log", {
        token_id: tokenId,
      }).catch(() => null);
      if (Array.isArray(fromChain) && fromChain.length > 0) return fromChain;
      return context.store.getOpenQuotes(tokenId).flatMap((entry) =>
        typeof entry.quote_id === "string" &&
        typeof entry.deposit_address === "string" &&
        typeof entry.refund_to === "string" &&
        typeof entry.route_id === "string"
          ? [
              {
                quote_id: entry.quote_id,
                deposit_address: entry.deposit_address,
                deadline_requested:
                  typeof entry.deadline_requested === "number" ? entry.deadline_requested : 0,
                refund_to: entry.refund_to,
                route_id: entry.route_id,
              },
            ]
          : [],
      );
    },
  };
}

export function oneClickRefundQuotes(): RefundQuotePort {
  const routes = loadRoutes();
  return {
    async quote(input) {
      const route = routes.routes.find((entry) => entry.id === input.routeId);
      if (route === undefined) throw new ApiError(400, "unknown_route");
      const client = createOneClickClientFromEnv();
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const response = await client
        .quote({
          originAsset: defaultSettlementAsset(),
          destinationAsset: route.originAssetId,
          amount: input.amount,
          swapType: "EXACT_INPUT",
          slippageTolerance: 30,
          refundTo: input.claimAccount,
          recipient: input.refundTo,
          recipientType: "DESTINATION_CHAIN",
          depositType: "INTENTS",
          refundType: "INTENTS",
          dry: false,
          deadline,
        })
        .catch((error: unknown) => {
          throw new ApiError(
            502,
            "refund_quote_failed",
            error instanceof Error ? error.message : "refund quote failed",
          );
        });
      const depositAddress = response.quote.depositAddress ?? "";
      if (depositAddress === "")
        throw new ApiError(502, "refund_quote_failed", "no deposit address");
      return {
        quote_id: "",
        deposit_address: depositAddress,
        amount_in: response.quote.amountIn ?? input.amount,
        amount_out: response.quote.amountOut ?? input.amount,
        deadline: response.quote.deadline ?? deadline,
        recipient: input.refundTo,
      };
    },
  };
}

const EVENT_NAMES: Readonly<Record<string, string>> = {
  checkout_created: "checkout.created",
  checkout_paid: "checkout.paid",
  checkout_partial: "checkout.partial",
  checkout_paid_late: "checkout.paid_late",
  checkout_accepted: "checkout.accepted",
  checkout_refund_started: "checkout.refund_started",
};

function noticeId(event: IndexedEvent, tokenId: string, data: Record<string, unknown>): string {
  const seq = data.booking_seq;
  if (
    (event.type === "checkout_paid" ||
      event.type === "checkout_partial" ||
      event.type === "checkout_paid_late") &&
    (typeof seq === "number" || typeof seq === "string")
  ) {
    return createHash("sha256").update(tokenId).update(String(seq)).digest("hex");
  }
  const bookedKey =
    unwrapU128(data.total_paid) ??
    unwrapU128(data.total_received) ??
    (typeof data.booked_at === "number" ? String(data.booked_at) : undefined) ??
    (typeof data.payout_id === "number" ? String(data.payout_id) : undefined);
  return createHash("sha256")
    .update(tokenId)
    .update("\u0000")
    .update(event.type)
    .update("\u0000")
    .update(String(seq ?? bookedKey ?? event.id))
    .digest("hex");
}

function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith("0x") && b.startsWith("0x")) return a.toLowerCase() === b.toLowerCase();
  return false;
}

export class Checkouts {
  private readonly port: (context: ApiModuleContext) => CheckoutPort;
  private readonly chain: (context: ApiModuleContext) => CheckoutChain;
  private readonly refunds: (context: ApiModuleContext) => RefundQuotePort;
  private readonly routes: RouteFile;
  private readonly settleGrace: number;
  /** One poke per checkout and money status; bounded so a long-lived process keeps no more than 500 ids. */
  private readonly poked = new Map<string, string>();

  constructor(options: CheckoutOptions = {}) {
    this.settleGrace = options.settleGraceSeconds ?? DEFAULT_SETTLE_GRACE_SECONDS;
    this.port = options.checkouts ?? issuerCheckoutPort;
    this.chain = options.chain ?? defaultCheckoutChain;
    this.refunds = options.refunds ?? oneClickRefundQuotes;
    this.routes = loadRoutes();
  }

  private pokeOnce(context: ApiModuleContext, tokenId: string, status: string): void {
    if (!POKE_STATUSES.has(status)) return;
    if (this.poked.get(tokenId) === status) return;
    this.poked.set(tokenId, status);
    if (this.poked.size > 500) {
      const oldest = this.poked.keys().next().value;
      if (oldest !== undefined) this.poked.delete(oldest);
    }
    void context.pokeIndexer?.().catch(() => undefined);
  }

  async route(request: ApiRequest, context: ApiModuleContext): Promise<ApiResponse | undefined> {
    const { method, path } = request;

    const publicMatch = /^\/v1\/public\/checkouts\/([^/]+)$/.exec(path);
    if (publicMatch !== null && method === "GET") {
      return this.publicView(context, decodeURIComponent(publicMatch[1] ?? ""));
    }

    if (path === "/v1/checkouts") {
      const auth = context.requireAuth(request);
      if (method === "POST") {
        context.requireScope(auth, "invoices:write");
        this.requireIdempotencyKey(request);
        return context.withIdempotency(request, async () =>
          this.create(context, auth.accountId, request.body),
        );
      }
      if (method === "GET") {
        context.requireScope(auth, "invoices:read");
        return this.list(context, auth.accountId, request.query);
      }
      return undefined;
    }

    const actionMatch = /^\/v1\/checkouts\/([^/]+)\/(accept_late|refund_quote)$/.exec(path);
    if (actionMatch !== null && method === "POST") {
      const auth = context.requireAuth(request);
      context.requireScope(auth, "invoices:write");
      this.requireIdempotencyKey(request);
      const id = decodeURIComponent(actionMatch[1] ?? "");
      const action = actionMatch[2];
      return context.withIdempotency(request, async () =>
        action === "accept_late"
          ? this.acceptLate(context, auth.accountId, id)
          : this.refundQuote(context, auth.accountId, id, request.body),
      );
    }

    const itemMatch = /^\/v1\/checkouts\/([^/]+)$/.exec(path);
    if (itemMatch !== null && method === "GET") {
      const auth = context.requireAuth(request);
      context.requireScope(auth, "invoices:read");
      const stored = this.owned(context, auth.accountId, decodeURIComponent(itemMatch[1] ?? ""));
      return { status: 200, body: await this.hydrate(context, stored) };
    }

    return undefined;
  }

  async quoteWindow(tokenId: string, context: ApiModuleContext): Promise<QuoteWindow | undefined> {
    const stored = context.docs.get<StoredCheckout>(NS_CHECKOUTS, tokenId);
    if (stored === undefined) return undefined;
    const view = await this.hydrate(context, stored);
    if (view.status === "expired") {
      throw new ApiError(409, "checkout_expired", "this checkout has expired");
    }
    // When the chain cannot be read the quote goes on: the expiry below is the stored one.
    if (view.status !== "pending" && view.status !== "partial" && view.status !== "checking") {
      throw new ApiError(409, "checkout_not_payable", `checkout is ${view.status}`);
    }
    const nowSec = Math.floor(context.clock().getTime() / 1000);
    if (nowSec >= stored.expiry) {
      throw new ApiError(409, "checkout_expired", "this checkout has expired");
    }
    return { notAfter: stored.expiry };
  }

  /** Claims this merchant's checkouts own: core keeps a merchant's own events by these ids. */
  ownedTokens(accountId: string, context: ApiModuleContext): string[] {
    return context.docs
      .list<StoredCheckout>(NS_CHECKOUTS, accountId)
      .filter((row) => row.account_id === accountId)
      .map((row) => row.id);
  }

  events(event: IndexedEvent, context: ApiModuleContext): IndexedEvent[] {
    const mapped = EVENT_NAMES[event.type];
    if (mapped === undefined) return [];
    const raw = (event.data ?? {}) as Record<string, unknown>;
    const tokenId =
      typeof raw.token_id === "string" && raw.token_id !== "" ? raw.token_id : undefined;
    if (tokenId === undefined) return [];
    const stored = context.docs.get<StoredCheckout>(NS_CHECKOUTS, tokenId);
    if (stored === undefined) return [];
    const orderRef =
      typeof raw.order_ref === "string" && raw.order_ref !== "" && raw.order_ref !== tokenId
        ? raw.order_ref
        : stored.order_ref;
    const feeMode = stored.fee_mode ?? "absorb";
    const subtotalUsd = stored.subtotal_usd ?? stored.amount_usd;
    const feeUsd = stored.fee_usd ?? "0.00";
    const totalUsd = stored.total_usd ?? stored.amount_usd;
    const id = noticeId(event, tokenId, raw);
    this.pokeOnce(
      context,
      tokenId,
      mapped === "checkout.paid_late" ? "late" : mapped.replace("checkout.", ""),
    );
    if (mapped === "checkout.partial") {
      // A partial notice must never contain the word "paid".
      const clean: Record<string, unknown> = {
        token_id: tokenId,
        order_ref: orderRef,
        amount_usd: totalUsd,
        subtotal_usd: subtotalUsd,
        fee_usd: feeUsd,
        total_usd: totalUsd,
        fee_mode: feeMode,
        ...(raw.due === undefined ? {} : { due: String(unwrapU128(raw.due) ?? raw.due) }),
        ...(raw.received === undefined
          ? {}
          : { received: String(unwrapU128(raw.received) ?? raw.received) }),
        ...(raw.total_received === undefined
          ? {}
          : { total_received: String(unwrapU128(raw.total_received) ?? raw.total_received) }),
        ...(raw.remaining === undefined
          ? {}
          : { remaining: String(unwrapU128(raw.remaining) ?? raw.remaining) }),
        ...(raw.booking_seq === undefined ? {} : { booking_seq: raw.booking_seq }),
        status: "partial",
      };
      return [{ id, type: mapped, created: event.created, data: clean, indexed: true }];
    }
    const status =
      mapped === "checkout.paid"
        ? "paid"
        : mapped === "checkout.paid_late"
          ? "late"
          : mapped === "checkout.accepted"
            ? "accepted"
            : mapped === "checkout.refund_started"
              ? "refund_started"
              : "pending";
    const amountCents = Math.round(Number(totalUsd) * 100);
    const bookingTx =
      typeof raw.booking_tx === "string"
        ? raw.booking_tx
        : typeof raw.tx_hash === "string"
          ? raw.tx_hash
          : typeof (event as { txHash?: unknown }).txHash === "string"
            ? ((event as { txHash?: string }).txHash as string)
            : null;
    const originTx =
      typeof raw.origin_tx === "string"
        ? raw.origin_tx
        : typeof raw.origin_tx_hash === "string"
          ? raw.origin_tx_hash
          : null;
    const transactions = { origin: originTx, booking: bookingTx };
    const timestamp = new Date(event.created * 1000).toISOString();

    return [
      {
        id,
        type: mapped,
        created: event.created,
        data: {
          ...raw,
          token_id: tokenId,
          checkout_id: stored.id,
          order_ref: orderRef,
          amount_cents: amountCents,
          amount_usd_cents: amountCents,
          amount_usd: totalUsd,
          subtotal_usd: subtotalUsd,
          fee_usd: feeUsd,
          total_usd: totalUsd,
          fee_mode: feeMode,
          booking_tx: bookingTx,
          origin_tx: originTx,
          transactions,
          timestamp,
          status,
          customer_name: stored.customer_name ?? null,
          order_number: stored.order_number ?? null,
        },
        indexed: true,
      },
    ];
  }

  private requireIdempotencyKey(request: ApiRequest): void {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim() === "") {
      throw new ApiError(400, "idempotency_key_required", "Idempotency-Key header is required");
    }
  }

  private owned(context: ApiModuleContext, accountId: string, id: string): StoredCheckout {
    const stored = context.docs.get<StoredCheckout>(NS_CHECKOUTS, id);
    if (stored === undefined || stored.account_id !== accountId) {
      throw new ApiError(404, "checkout_not_found");
    }
    return stored;
  }

  private async create(
    context: ApiModuleContext,
    accountId: string,
    raw: unknown,
  ): Promise<ApiResponse> {
    if (typeof raw !== "object" || raw === null) bad("body must be a JSON object");
    const body = raw as Record<string, unknown>;
    if (body.currency !== undefined && body.currency !== null) {
      if (
        typeof body.currency !== "string" ||
        !["USD", "USDC"].includes(body.currency.toUpperCase())
      ) {
        throw new ApiError(
          400,
          "unsupported_currency",
          "currency must be USD; other currencies are not supported",
        );
      }
    }
    const orderRef = body.order_ref;
    if (typeof orderRef !== "string" || !ORDER_REF_RE.test(orderRef)) {
      bad("order_ref is required (1..64 ASCII letters, digits, ., _, :, -)");
    }
    const rawAmount =
      body.amount_usd ??
      (typeof body.amount_cents === "number"
        ? (body.amount_cents / 100).toFixed(2)
        : typeof body.amount_usd_cents === "number"
          ? (body.amount_usd_cents / 100).toFixed(2)
          : undefined);
    const amount = parseUsd(rawAmount, "amount_usd");

    const refKey = `${accountId}/${orderRef}`;
    const existingRef = context.docs.get<{ token_id: string }>(NS_REFS, refKey);
    if (existingRef?.token_id) {
      const existing = context.docs.get<StoredCheckout>(NS_CHECKOUTS, existingRef.token_id);
      if (existing) {
        const existingSubtotal = existing.subtotal_usd ?? existing.amount_usd;
        if (existingSubtotal !== amount.text) {
          throw new ApiError(
            409,
            "order_ref_amount_mismatch",
            `checkout with order_ref '${orderRef}' already exists with amount ${existingSubtotal} USD (requested ${amount.text} USD)`,
          );
        }
        return { status: 200, body: await this.hydrate(context, existing) };
      }
    }

    const rawFeeMode = body.fee_mode;
    let feeMode: FeeMode;
    if (rawFeeMode === undefined || rawFeeMode === null) {
      const biz = context.store.getBusiness(accountId) as
        (BusinessRecord & { fee_mode?: FeeMode }) | undefined;
      feeMode = biz?.fee_mode === "pass_to_customer" ? "pass_to_customer" : "absorb";
    } else if (rawFeeMode === "absorb" || rawFeeMode === "pass_to_customer") {
      feeMode = rawFeeMode;
    } else {
      throw new ApiError(
        400,
        "invalid_fee_mode",
        "fee_mode must be 'absorb' or 'pass_to_customer'",
      );
    }

    const feeBreakdown = computeFeeBreakdown(amount.text, feeMode);
    const effectiveAmount = parseUsd(feeBreakdown.totalUsd, "amount_usd");

    const expiryMinutes = body.expires_in_minutes === undefined ? 15 : body.expires_in_minutes;
    if (
      typeof expiryMinutes !== "number" ||
      !Number.isInteger(expiryMinutes) ||
      expiryMinutes < 1 ||
      expiryMinutes > 60
    ) {
      bad("expires_in_minutes must be an integer between 1 and 60");
    }
    const returnUrl = parseHttpsUrl(body.return_url, "return_url");
    const cancelUrl = parseHttpsUrl(body.cancel_url, "cancel_url");
    // Plain text only, short: it is shown to the merchant, never sent on chain.
    const customerName =
      typeof body.customer_name === "string" ? plainText(body.customer_name, 120) || null : null;
    const orderNumber =
      typeof body.order_number === "string" || typeof body.order_number === "number"
        ? plainText(String(body.order_number), 40) || null
        : null;
    const rawItems = body.items;
    const feeResolved = resolveFee(amount.text, [], feeMode);
    const feeItem = feeResolved.items[0];
    const effectiveItems =
      feeMode === "pass_to_customer" && feeItem !== undefined
        ? [
            ...(Array.isArray(rawItems) ? (rawItems as CheckoutItem[]) : []),
            {
              name: feeItem.description,
              quantity: feeItem.quantity,
              unit_price_usd: feeItem.unit_amount_usd,
            },
          ]
        : rawItems;
    const itemsSha256 = hashItems(effectiveItems);

    if (!context.docs.insert(NS_REFS, refKey, { order_ref: orderRef }, accountId)) {
      throw new ApiError(
        409,
        "order_ref_taken",
        "this business already has a checkout with that order_ref",
      );
    }
    let created;
    try {
      created = await this.port(context).create({
        accountId,
        amountUsd: effectiveAmount.text,
        orderRef,
        expiryMinutes,
        ...(returnUrl === undefined ? {} : { returnUrl }),
        ...(cancelUrl === undefined ? {} : { cancelUrl }),
        itemsSha256,
      });
    } catch (error) {
      context.docs.delete(NS_REFS, refKey);
      throw error;
    }

    const tokenId = created.token_id;
    const claimAccount = created.claim_account ?? `${tokenId}.claims.${context.config.rootAccount}`;
    const expiry = Math.floor(Date.parse(created.expires_at) / 1000);
    const nowIso = context.clock().toISOString();
    const stored: StoredCheckout = {
      id: tokenId,
      token_id: tokenId,
      claim_account: claimAccount,
      account_id: accountId,
      order_ref: orderRef,
      amount_usd: effectiveAmount.text,
      amount_due: effectiveAmount.baseUnits,
      amount_cents: Number(effectiveAmount.cents),
      currency: "USD",
      expires_at: created.expires_at,
      expiry,
      pay_url: created.pay_url,
      return_url: returnUrl ?? null,
      cancel_url: cancelUrl ?? null,
      items_sha256: itemsSha256,
      created_at: nowIso,
      fee_mode: feeMode,
      subtotal_usd: feeBreakdown.subtotalUsd,
      fee_usd: feeBreakdown.feeUsd,
      total_usd: feeBreakdown.totalUsd,
      customer_name: customerName,
      order_number: orderNumber,
    };
    context.docs.put(NS_CHECKOUTS, tokenId, stored, accountId);
    context.docs.put(NS_REFS, refKey, { token_id: tokenId }, accountId);

    const view: CheckoutView = {
      id: tokenId,
      token_id: tokenId,
      claim_account: claimAccount,
      order_ref: orderRef,
      amount_usd: effectiveAmount.text,
      amount_due: effectiveAmount.baseUnits,
      amount_cents: Number(effectiveAmount.cents),
      currency: "USD",
      outstanding: effectiveAmount.baseUnits,
      paid_total: "0",
      surplus: "0",
      status: "pending",
      pay_url: created.pay_url,
      return_url: returnUrl ?? null,
      cancel_url: cancelUrl ?? null,
      expires_at: created.expires_at,
      created_at: nowIso,
      fee_mode: feeMode,
      subtotal_usd: feeBreakdown.subtotalUsd,
      fee_usd: feeBreakdown.feeUsd,
      total_usd: feeBreakdown.totalUsd,
    };
    return { status: 201, body: view };
  }

  /**
   * The claim and checkout state of a checkout. A settled checkout is answered from the copy kept the one
   * time it was read; one in flight is read from the chain, and when the chain cannot be read the last copy
   * read answers with `checking` set (no copy yet gives an empty claim: the stored amounts still show).
   */
  private async snapshot(
    context: ApiModuleContext,
    stored: StoredCheckout,
  ): Promise<ChainSnapshot & { checking: boolean }> {
    const kept = context.docs.get<ChainSnapshot>(NS_SETTLED, stored.token_id);
    if (kept !== undefined) return { ...kept, checking: false };
    const chain = this.chain(context);
    try {
      const [claim, state] = await Promise.all([
        chain.claim(stored.token_id),
        chain.checkoutState(stored.token_id),
      ]);
      const fresh: ChainSnapshot = { claim, state };
      context.docs.put(NS_LAST, stored.token_id, fresh, stored.account_id);
      return { ...fresh, checking: false };
    } catch {
      // The chain could not be read just now (a busy or exhausted RPC). What was read last is still true for a payment
      // that only moves forward, so the page keeps showing it instead of dropping to "checking" and back. Only a
      // checkout never read at all is "checking".
      const last = context.docs.get<ChainSnapshot>(NS_LAST, stored.token_id);
      if (last !== undefined) return { claim: last.claim, state: last.state, checking: false };
      return { claim: {}, state: null, checking: true };
    }
  }

  /** Keeps a checkout that can no longer change, so it is never read from the chain again. */
  private async settle(
    context: ApiModuleContext,
    stored: StoredCheckout,
    snap: ChainSnapshot,
    status: CheckoutStatus,
    state: ChainCheckoutState | null,
    expiry: number,
    nowSec: number,
  ): Promise<void> {
    if (context.docs.get(NS_SETTLED, stored.token_id) !== undefined) return;
    const isLateOpen =
      state?.late === true && toBig(heldAmountOf(state)) > 0n && state?.accepted !== true;
    const final =
      !isLateOpen &&
      (status === "paid" ||
        ((status === "expired" || status === "accepted" || status === "refunded") &&
          nowSec >= expiry + this.settleGrace));
    if (final) {
      let receipts: Record<string, unknown>[] | undefined;
      if (context.indexer?.listReceipts !== undefined) {
        try {
          receipts = await context.indexer.listReceipts(stored.account_id, stored.token_id);
        } catch {
          // indexer failure does not prevent settling
        }
      }
      context.docs.put(
        NS_SETTLED,
        stored.token_id,
        { claim: snap.claim, state: snap.state, receipts },
        stored.account_id,
      );
    }
  }

  private async hydrate(context: ApiModuleContext, stored: StoredCheckout): Promise<CheckoutView> {
    const snap = await this.snapshot(context, stored);
    const rawClaim = snap.claim;
    const state = snap.state;
    const claim = normaliseClaim(rawClaim, stored);
    const nowSec = Math.floor(context.clock().getTime() / 1000);
    const computed = statusOf(claim, state, stored, nowSec);
    const expiry =
      state?.expiry ?? (typeof claim.due_date === "number" ? claim.due_date : stored.expiry);
    const status: CheckoutStatus = snap.checking ? "checking" : computed;
    if (!snap.checking) {
      this.pokeOnce(context, stored.token_id, status);
      await this.settle(context, stored, snap, computed, state, expiry, nowSec);
    }
    const feeMode: FeeMode = stored.fee_mode ?? "absorb";
    const subtotalUsd = stored.subtotal_usd ?? stored.amount_usd;
    const feeUsd = stored.fee_usd ?? "0.00";
    const totalUsd = stored.total_usd ?? stored.amount_usd;
    const business = context.store.getBusiness(stored.account_id);
    const merchantName = business?.legal_name?.trim() || undefined;
    return {
      id: stored.id,
      token_id: stored.token_id,
      claim_account:
        typeof claim.claim_account === "string" && claim.claim_account !== ""
          ? claim.claim_account
          : stored.claim_account,
      order_ref: stored.order_ref,
      amount_usd: stored.amount_usd,
      amount_due: String(claim.amount_due),
      amount_cents: Math.round(Number(stored.amount_usd) * 100),
      currency: "USD",
      outstanding: outstandingOf(claim),
      paid_total: paidTotalOf(claim, "0"),
      surplus: String(claim.surplus),
      status,
      pay_url: stored.pay_url,
      return_url: stored.return_url,
      cancel_url: stored.cancel_url ?? null,
      expires_at: new Date(expiry * 1000).toISOString(),
      created_at: stored.created_at,
      merchant_name: merchantName,
      fee_mode: feeMode,
      subtotal_usd: subtotalUsd,
      fee_usd: feeUsd,
      total_usd: totalUsd,
    };
  }

  private async list(
    context: ApiModuleContext,
    accountId: string,
    query: URLSearchParams,
  ): Promise<ApiResponse> {
    const rawLimit = Number(query.get("limit") ?? "50");
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
    const cursor = query.get("cursor") ?? query.get("starting_after") ?? undefined;
    const all = context.docs
      .list<StoredCheckout>(NS_CHECKOUTS, accountId)
      .filter((row) => row.account_id === accountId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const start = cursor === undefined ? 0 : all.findIndex((row) => row.id === cursor) + 1;
    const slice = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    const data = await Promise.all(slice.map((row) => this.hydrate(context, row)));
    return {
      status: 200,
      body: {
        data,
        has_more: hasMore,
        next_cursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
      },
    };
  }

  private async publicView(context: ApiModuleContext, id: string): Promise<ApiResponse> {
    const stored = context.docs.get<StoredCheckout>(NS_CHECKOUTS, id);
    if (stored === undefined) throw new ApiError(404, "checkout_not_found");
    const view = await this.hydrate(context, stored);
    return {
      status: 200,
      body: {
        id: view.id,
        token_id: view.token_id,
        claim_account: view.claim_account,
        merchant: stored.account_id,
        merchant_name: view.merchant_name,
        order_ref: view.order_ref,
        amount_usd: view.amount_usd,
        amount_due: view.amount_due,
        subtotal_usd: view.subtotal_usd,
        fee_usd: view.fee_usd,
        total_usd: view.total_usd,
        fee_mode: view.fee_mode,
        outstanding: view.outstanding,
        paid_total: view.paid_total,
        surplus: view.surplus,
        status: view.status,
        expires_at: view.expires_at,
        return_url: view.return_url,
        cancel_url: view.cancel_url ?? null,
        amount_cents: view.amount_cents,
        currency: view.currency,
        server_time: context.clock().toISOString(),
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
        sessions: context.store.listPaySessions(view.token_id),
        ...(view.status === "pending" || view.status === "checking"
          ? {}
          : { history: await this.history(context, stored) }),
      },
    };
  }

  /**
   * What happened to this checkout, for the page that has nothing left to pay: when it was made, when the money was
   * booked and the transactions that prove it (the same shape an invoice's page gets). Extra information only: a failing
   * lookup gives an empty list and never takes the page down.
   */
  private async history(
    context: ApiModuleContext,
    stored: StoredCheckout,
  ): Promise<{
    issued_at: string;
    paid_at: string | null;
    issue_tx: string | null;
    payments: { tx_hash: string; near: boolean }[];
  }> {
    const settled = context.docs.get<{ receipts?: Record<string, unknown>[] }>(
      NS_SETTLED,
      stored.token_id,
    );
    let receipts = settled?.receipts;
    if (receipts === undefined && context.indexer?.listReceipts !== undefined) {
      try {
        receipts = await context.indexer.listReceipts(stored.account_id, stored.token_id);
      } catch {
        receipts = undefined;
      }
    }
    const payments: { tx_hash: string; near: boolean }[] = [];
    const seen = new Set<string>();
    const add = (hash: string, near: boolean) => {
      if (seen.has(hash)) return;
      seen.add(hash);
      payments.push({ tx_hash: hash, near });
    };
    let paidAt: string | null = null;
    for (const r of receipts ?? []) {
      const origin = (r.origin_tx as { hash?: unknown } | null | undefined)?.hash;
      if (typeof origin === "string") add(origin, false);
      if (Array.isArray(r.near_tx_hashes))
        for (const h of r.near_tx_hashes) if (typeof h === "string") add(h, true);
      // The booking transaction on NEAR is always there, whatever the provider's evidence says.
      if (typeof r.booking_tx === "string") add(r.booking_tx, true);
      if (typeof r.time === "string" && (paidAt === null || r.time > paidAt)) paidAt = r.time;
    }
    let issueTx: string | null = null;
    if (context.indexer?.issueTx !== undefined) {
      try {
        issueTx = (await context.indexer.issueTx(stored.token_id)) ?? null;
      } catch {
        issueTx = null;
      }
    }
    return { issued_at: stored.created_at, paid_at: paidAt, issue_tx: issueTx, payments };
  }

  private async requireLate(
    context: ApiModuleContext,
    accountId: string,
    id: string,
  ): Promise<{
    stored: StoredCheckout;
    claim: Record<string, unknown>;
    state: ChainCheckoutState;
  }> {
    const stored = this.owned(context, accountId, id);
    const snap = await this.snapshot(context, stored);
    if (snap.checking) {
      throw new ApiError(
        503,
        "checkout_checking",
        "the chain cannot be read now; try again shortly",
      );
    }
    const rawClaim = snap.claim;
    const state = snap.state;
    const claim = normaliseClaim(rawClaim, stored);
    if (state?.flagged === true) {
      throw new ApiError(409, "checkout_flagged", "this checkout is flagged for accounting review");
    }
    const held = toBig(heldAmountOf(state));
    if (state?.refunded === true && held <= 0n) {
      throw new ApiError(
        409,
        "checkout_already_refunded",
        "this late checkout has already been refunded",
      );
    }
    const status = statusOf(claim, state, stored, Math.floor(context.clock().getTime() / 1000));
    if (status === "accepted") {
      throw new ApiError(
        409,
        "checkout_already_accepted",
        "this late checkout has already been accepted",
      );
    }
    if (state === null || state.late !== true) {
      throw new ApiError(409, "checkout_not_late", "this checkout does not have a late payment");
    }
    return { stored, claim, state };
  }

  private async acceptLate(
    context: ApiModuleContext,
    accountId: string,
    id: string,
  ): Promise<ApiResponse> {
    const { stored } = await this.requireLate(context, accountId, id);
    return {
      status: 200,
      body: {
        checkout_id: stored.id,
        token_id: stored.token_id,
        signer_id: accountId,
        action: {
          receiver_id: context.config.rootAccount,
          method: "accept_late",
          args: { token_id: stored.token_id },
          gas: "50000000000000",
          deposit: "0",
        },
      },
    };
  }

  private async refundQuote(
    context: ApiModuleContext,
    accountId: string,
    id: string,
    rawBody: unknown,
  ): Promise<ApiResponse> {
    const { stored, claim, state } = await this.requireLate(context, accountId, id);
    const log = await this.chain(context).paymentLog(stored.token_id);
    const valid = log.filter((entry) => entry.refund_to !== "" && entry.route_id !== "");
    if (valid.length === 0) {
      throw new ApiError(
        409,
        "no_recorded_refund_to",
        "no payer refund_to is recorded in the payment log of this checkout",
      );
    }
    const body =
      typeof rawBody === "object" && rawBody !== null ? (rawBody as Record<string, unknown>) : {};
    const wantedQuoteId = typeof body.quote_id === "string" ? body.quote_id : undefined;
    let chosen: LoggedQuote | undefined;
    if (wantedQuoteId !== undefined) {
      chosen = valid.find((entry) => entry.quote_id === wantedQuoteId);
      if (chosen === undefined) {
        throw new ApiError(
          404,
          "quote_not_found",
          "quote_id is not in this checkout's payment log",
        );
      }
    } else {
      const destinations = new Set(
        valid.map((entry) => `${entry.route_id}\u0000${entry.refund_to}`),
      );
      if (destinations.size > 1) {
        throw new ApiError(
          409,
          "ambiguous_refund_to",
          "more than one refund_to is recorded; pass the quote_id to refund",
        );
      }
      chosen = valid[valid.length - 1];
    }
    if (chosen === undefined) {
      throw new ApiError(409, "no_recorded_refund_to");
    }

    const heldRaw = heldAmountOf(state);
    const net =
      heldRaw !== undefined ? BigInt(heldRaw) : toBig(claim.booked_total) - toBig(claim.fee_total);
    if (net <= 0n) {
      throw new ApiError(409, "nothing_to_refund", "no net balance is held on this checkout");
    }

    const quote = await this.refunds(context).quote({
      tokenId: stored.token_id,
      claimAccount: stored.claim_account,
      refundTo: chosen.refund_to,
      routeId: chosen.route_id,
      amount: net.toString(),
    });
    if (!sameAddress(quote.recipient, chosen.refund_to)) {
      throw new ApiError(
        502,
        "refund_quote_recipient_mismatch",
        "the swap quote recipient does not match the recorded refund_to",
      );
    }
    const amountIn = toBig(quote.amount_in);
    if (amountIn <= 0n || amountIn > net) {
      throw new ApiError(
        502,
        "refund_quote_exceeds_held_amount",
        "the swap quote amount_in exceeds the held balance on this checkout",
      );
    }

    return {
      status: 200,
      body: {
        checkout_id: stored.id,
        token_id: stored.token_id,
        signer_id: accountId,
        refund_to: chosen.refund_to,
        route_id: chosen.route_id,
        quote: {
          quote_id: quote.quote_id,
          deposit_address: quote.deposit_address,
          amount_in: quote.amount_in,
          amount_out: quote.amount_out,
          deadline: quote.deadline,
        },
        action: {
          receiver_id: context.config.rootAccount,
          method: "refund_late",
          args: {
            token_id: stored.token_id,
            deposit_address: quote.deposit_address,
            amount_in: quote.amount_in,
          },
          gas: "300000000000000",
          deposit: "0",
        },
      },
    };
  }
}
