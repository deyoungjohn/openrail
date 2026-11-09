/**
 * Payment links: a reusable template (`/l/<business>/<slug>`). Nothing is on-chain until a visitor
 * presses Pay; each press creates one fresh Checkout claim, so one link serves many buyers and every
 * payment is still matched exactly. Sessions are rate-limited per link.
 */
import { randomBytes } from "node:crypto";
import { ApiError, type ApiRequest, type ApiResponse } from "../../app.js";
import type { ApiModuleContext } from "../../modules.js";
import type { IndexedEvent } from "../../webhooks.js";
import type { CheckoutPort, CreatedCheckout } from "./checkout-port.js";

export type LinkAmount =
  | { type: "fixed"; amount_usd: string }
  | { type: "custom"; min_usd: string; max_usd: string | null };

export interface PaymentLink {
  id: string;
  account_id: string;
  slug: string;
  title: string;
  description: string | null;
  image_url: string | null;
  amount: LinkAmount;
  /** null = quantity fixed at 1. */
  quantity: { max: number } | null;
  active: boolean;
  rate_limit_per_hour: number;
  public_path: string;
  created_at: string;
  updated_at: string;
}

export interface LinkSession {
  id: string;
  payment_link_id: string;
  account_id: string;
  token_id: string;
  checkout_id: string;
  order_ref: string;
  amount_usd: string;
  quantity: number;
  pay_url: string;
  expires_at: string;
  paid_at: string | null;
  event_id: string | null;
  created_at: string;
}

export interface PaymentLinkOptions {
  checkouts: (context: ApiModuleContext) => CheckoutPort;
  defaultRateLimit?: number;
  sessionExpiryMinutes?: number;
}

const NS_LINKS = "checkout.payment_links";
const NS_SLUGS = "checkout.payment_link_slugs";
const NS_SESSIONS = "checkout.payment_link_sessions";
const NS_TOKENS = "checkout.payment_link_tokens";
const NS_RATE = "checkout.payment_link_rate";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const AMOUNT = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;
const HOUR_MS = 60 * 60 * 1000;
const MAX_RATE = 1000;
const MAX_QUANTITY = 1000;

function bad(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}

function newId(prefix: string): string {
  // 12 lowercase base-36 characters (about 62 bits).
  const bytes = randomBytes(12);
  let out = "";
  for (const byte of bytes) out += (byte % 36).toString(36);
  return `${prefix}_${out}`;
}

function usd(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number") bad(`${field} must be an amount`);
  const text = String(value);
  if (!AMOUNT.test(text) || Number(text) <= 0) {
    bad(`${field} must be a positive amount with at most two decimals`);
  }
  return Number(text).toFixed(2);
}

function cents(value: string): bigint {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole ?? "0") * 100n + BigInt(frac.padEnd(2, "0"));
}

function fromCents(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function text(value: unknown, field: string, max: number, optional = false): string | null {
  if (value === undefined || value === null) {
    if (optional) return null;
    bad(`${field} required`);
  }
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    bad(`${field} must be 1-${max} characters`);
  }
  return value;
}

function imageUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 500) bad("image_url must be an https URL");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") bad("image_url must be an https URL");
    return url.toString();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return bad("image_url must be an https URL");
  }
}

function amount(value: unknown): LinkAmount {
  if (value === null || typeof value !== "object") bad("amount required");
  const raw = value as Record<string, unknown>;
  if (raw.type === "fixed")
    return { type: "fixed", amount_usd: usd(raw.amount_usd, "amount.amount_usd") };
  if (raw.type === "custom") {
    const min = usd(raw.min_usd, "amount.min_usd");
    const max =
      raw.max_usd === undefined || raw.max_usd === null ? null : usd(raw.max_usd, "amount.max_usd");
    if (max !== null && cents(max) < cents(min)) bad("amount.max_usd must be at least min_usd");
    return { type: "custom", min_usd: min, max_usd: max };
  }
  return bad("amount.type must be fixed or custom");
}

function quantity(value: unknown): { max: number } | null {
  if (value === undefined || value === null) return null;
  const max = (value as { max?: unknown }).max;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_QUANTITY) {
    bad(`quantity.max must be an integer from 1 to ${MAX_QUANTITY}`);
  }
  return { max };
}

function rateLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RATE) {
    bad(`rate_limit_per_hour must be an integer from 1 to ${MAX_RATE}`);
  }
  return value;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    bad("JSON object body required");
  return body as Record<string, unknown>;
}

function publicView(link: PaymentLink) {
  return {
    id: link.id,
    business: link.account_id,
    title: link.title,
    description: link.description,
    image_url: link.image_url,
    amount: link.amount,
    quantity: link.quantity,
    active: link.active,
  };
}

/** `pl_<link suffix>_<session suffix>`: the checkout's order_ref for a link session. */
export function linkOrderRef(linkId: string, sessionId: string): string {
  return `pl_${linkId.slice(3)}_${sessionId.slice(3)}`;
}

function parseOrderRef(orderRef: string): { linkId: string; sessionId: string } | undefined {
  const match = /^pl_([a-z0-9]+)_([a-z0-9]+)$/.exec(orderRef);
  if (match === null) return undefined;
  return { linkId: `pl_${match[1]}`, sessionId: `ps_${match[2]}` };
}

const PATCHABLE = new Set([
  "active",
  "title",
  "description",
  "image_url",
  "amount",
  "quantity",
  "rate_limit_per_hour",
]);

export class PaymentLinks {
  private readonly defaultRate: number;
  private readonly expiryMinutes: number;

  constructor(private readonly options: PaymentLinkOptions) {
    this.defaultRate = options.defaultRateLimit ?? 30;
    this.expiryMinutes = options.sessionExpiryMinutes ?? 60;
  }

  async route(request: ApiRequest, context: ApiModuleContext): Promise<ApiResponse | undefined> {
    const { method, path } = request;
    const publicMatch = /^\/v1\/public\/payment_links\/([^/]+)\/([^/]+)$/.exec(path);
    if (publicMatch !== null && method === "GET") {
      const link = this.bySlug(
        context,
        decodeURIComponent(publicMatch[1] ?? ""),
        decodeURIComponent(publicMatch[2] ?? ""),
      );
      if (link === undefined) throw new ApiError(404, "payment_link_not_found");
      return { status: 200, body: publicView(link) };
    }
    const sessionMatch = /^\/v1\/payment_links\/([^/]+)\/sessions$/.exec(path);
    if (sessionMatch !== null && method === "POST") {
      return this.createSession(context, sessionMatch[1] ?? "", request.body);
    }
    if (path === "/v1/payment_links") {
      const auth = context.requireAuth(request);
      if (method === "POST") {
        context.requireScope(auth, "invoices:write");
        return context.withIdempotency(request, async () =>
          this.create(context, auth.accountId, request.body),
        );
      }
      if (method === "GET") {
        context.requireScope(auth, "invoices:read");
        return {
          status: 200,
          body: {
            data: context.docs
              .list<PaymentLink>(NS_LINKS, auth.accountId)
              .filter((link) => link.account_id === auth.accountId),
          },
        };
      }
      return undefined;
    }
    const itemMatch = /^\/v1\/payment_links\/([^/]+)(\/payments)?$/.exec(path);
    if (itemMatch !== null) {
      const auth = context.requireAuth(request);
      context.requireScope(auth, method === "GET" ? "invoices:read" : "invoices:write");
      const link = context.docs.get<PaymentLink>(NS_LINKS, itemMatch[1] ?? "");
      if (link === undefined || link.account_id !== auth.accountId) {
        throw new ApiError(404, "payment_link_not_found");
      }
      if (itemMatch[2] !== undefined) {
        if (method !== "GET") return undefined;
        return { status: 200, body: { data: this.payments(context, link) } };
      }
      if (method === "GET") return { status: 200, body: link };
      if (method === "PATCH") return { status: 200, body: this.patch(context, link, request.body) };
    }
    return undefined;
  }

  /** Adds `payment_link.paid` after a paid checkout that belongs to a link session. */
  events(event: IndexedEvent, context: ApiModuleContext): IndexedEvent[] {
    if (event.type !== "checkout_paid" && event.type !== "checkout.paid") return [];
    const data = (event.data ?? {}) as Record<string, unknown>;
    const tokenId = typeof data.token_id === "string" ? data.token_id : undefined;
    if (tokenId === undefined) return [];
    let sessionId: string | undefined;
    if (typeof data.order_ref === "string") {
      sessionId = parseOrderRef(data.order_ref)?.sessionId;
    } else {
      sessionId = context.docs.get<{ session_id: string }>(NS_TOKENS, tokenId)?.session_id;
    }
    if (sessionId === undefined) return [];
    const session = context.docs.get<LinkSession>(NS_SESSIONS, sessionId);
    // The session must exist and own this exact token; an order_ref alone proves nothing.
    if (session === undefined || session.token_id !== tokenId) return [];
    if (typeof data.order_ref === "string" && data.order_ref !== session.order_ref) return [];
    if (session.paid_at === null) {
      context.docs.put(
        NS_SESSIONS,
        session.id,
        { ...session, paid_at: new Date(event.created * 1000).toISOString(), event_id: event.id },
        session.payment_link_id,
      );
    }
    return [
      {
        ...event,
        id: `${event.id}:payment_link.paid`,
        type: "payment_link.paid",
        data: { ...data, payment_link_id: session.payment_link_id, session_id: session.id },
      },
    ];
  }

  private bySlug(
    context: ApiModuleContext,
    account: string,
    slug: string,
  ): PaymentLink | undefined {
    const pointer = context.docs.get<{ link_id: string }>(NS_SLUGS, `${account}/${slug}`);
    return pointer === undefined
      ? undefined
      : context.docs.get<PaymentLink>(NS_LINKS, pointer.link_id);
  }

  private create(context: ApiModuleContext, accountId: string, raw: unknown): ApiResponse {
    const body = objectBody(raw);
    if (typeof body.slug !== "string" || !SLUG.test(body.slug)) {
      bad("slug must be 1-64 lowercase letters, digits or -, not starting or ending with -");
    }
    const now = context.clock().toISOString();
    const link: PaymentLink = {
      id: newId("pl"),
      account_id: accountId,
      slug: body.slug,
      title: text(body.title, "title", 120) as string,
      description: text(body.description, "description", 1000, true),
      image_url: imageUrl(body.image_url),
      amount: amount(body.amount),
      quantity: quantity(body.quantity),
      active: body.active === undefined ? true : body.active === true,
      rate_limit_per_hour: rateLimit(body.rate_limit_per_hour, this.defaultRate),
      public_path: `/l/${accountId}/${body.slug}`,
      created_at: now,
      updated_at: now,
    };
    if (
      !context.docs.insert(NS_SLUGS, `${accountId}/${link.slug}`, { link_id: link.id }, accountId)
    ) {
      throw new ApiError(409, "slug_taken", "this business already has a link with that slug");
    }
    context.docs.put(NS_LINKS, link.id, link, accountId);
    return { status: 201, body: link };
  }

  private patch(context: ApiModuleContext, link: PaymentLink, raw: unknown): PaymentLink {
    const body = objectBody(raw);
    for (const key of Object.keys(body)) {
      if (!PATCHABLE.has(key))
        throw new ApiError(400, "immutable_field", `${key} cannot be changed`);
    }
    const next: PaymentLink = { ...link, updated_at: context.clock().toISOString() };
    if ("active" in body) {
      if (typeof body.active !== "boolean") bad("active must be true or false");
      next.active = body.active;
    }
    if ("title" in body) next.title = text(body.title, "title", 120) as string;
    if ("description" in body) next.description = text(body.description, "description", 1000, true);
    if ("image_url" in body) next.image_url = imageUrl(body.image_url);
    if ("amount" in body) next.amount = amount(body.amount);
    if ("quantity" in body) next.quantity = quantity(body.quantity);
    if ("rate_limit_per_hour" in body)
      next.rate_limit_per_hour = rateLimit(body.rate_limit_per_hour, link.rate_limit_per_hour);
    context.docs.put(NS_LINKS, next.id, next, next.account_id);
    return next;
  }

  private sessionAmount(
    link: PaymentLink,
    body: Record<string, unknown>,
  ): { amount: string; quantity: number } {
    let qty = 1;
    if (body.quantity !== undefined) {
      const max = link.quantity?.max ?? 1;
      if (
        typeof body.quantity !== "number" ||
        !Number.isInteger(body.quantity) ||
        body.quantity < 1 ||
        body.quantity > max
      ) {
        bad(`quantity must be an integer from 1 to ${max}`);
      }
      qty = body.quantity;
    }
    if (link.amount.type === "fixed") {
      // The link's price, never a client-sent amount.
      return { amount: fromCents(cents(link.amount.amount_usd) * BigInt(qty)), quantity: qty };
    }
    const chosen = usd(body.amount_usd, "amount_usd");
    if (cents(chosen) < cents(link.amount.min_usd))
      bad(`amount_usd must be at least ${link.amount.min_usd}`);
    if (link.amount.max_usd !== null && cents(chosen) > cents(link.amount.max_usd)) {
      bad(`amount_usd must be at most ${link.amount.max_usd}`);
    }
    return { amount: fromCents(cents(chosen) * BigInt(qty)), quantity: qty };
  }

  /** Sliding one-hour window per link. Reserves a slot; the caller releases it on failure. */
  private reserve(context: ApiModuleContext, link: PaymentLink): { release: () => void } {
    const now = context.clock().getTime();
    const state = context.docs.get<{ at: number[] }>(NS_RATE, link.id) ?? { at: [] };
    const recent = state.at.filter((t) => now - t < HOUR_MS);
    if (recent.length >= link.rate_limit_per_hour) {
      const retryMs = HOUR_MS - (now - Math.min(...recent));
      throw Object.assign(
        new ApiError(429, "rate_limited", "too many payment sessions for this link; try later"),
        {
          retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
        },
      );
    }
    recent.push(now);
    context.docs.put(NS_RATE, link.id, { at: recent });
    return {
      release: () => {
        const current = context.docs.get<{ at: number[] }>(NS_RATE, link.id) ?? { at: [] };
        const index = current.at.lastIndexOf(now);
        if (index >= 0) current.at.splice(index, 1);
        context.docs.put(NS_RATE, link.id, current);
      },
    };
  }

  private async createSession(
    context: ApiModuleContext,
    linkId: string,
    raw: unknown,
  ): Promise<ApiResponse> {
    const link = context.docs.get<PaymentLink>(NS_LINKS, linkId);
    if (link === undefined) throw new ApiError(404, "payment_link_not_found");
    if (!link.active)
      throw new ApiError(409, "payment_link_inactive", "this payment link is turned off");
    const body = raw === undefined || raw === null ? {} : objectBody(raw);
    const { amount: amountUsd, quantity: qty } = this.sessionAmount(link, body);

    let slot: { release: () => void };
    try {
      slot = this.reserve(context, link);
    } catch (error) {
      const retry = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (error instanceof ApiError && retry !== undefined) {
        return {
          status: 429,
          body: { error: { code: error.code, message: error.message } },
          headers: { "retry-after": String(retry) },
        };
      }
      throw error;
    }

    const sessionId = newId("ps");
    const orderRef = linkOrderRef(link.id, sessionId);
    let checkout: CreatedCheckout;
    try {
      checkout = await this.options.checkouts(context).create({
        accountId: link.account_id,
        amountUsd,
        orderRef,
        expiryMinutes: this.expiryMinutes,
      });
    } catch {
      slot.release();
      throw new ApiError(
        502,
        "checkout_unavailable",
        "could not open a payment right now; try again",
      );
    }
    const session: LinkSession = {
      id: sessionId,
      payment_link_id: link.id,
      account_id: link.account_id,
      token_id: checkout.token_id,
      checkout_id: checkout.checkout_id,
      order_ref: orderRef,
      amount_usd: amountUsd,
      quantity: qty,
      pay_url: checkout.pay_url,
      expires_at: checkout.expires_at,
      paid_at: null,
      event_id: null,
      created_at: context.clock().toISOString(),
    };
    context.docs.put(NS_SESSIONS, session.id, session, link.id);
    context.docs.put(NS_TOKENS, checkout.token_id, { session_id: session.id });
    return {
      status: 201,
      body: {
        session_id: session.id,
        checkout_id: checkout.checkout_id,
        token_id: checkout.token_id,
        amount_usd: amountUsd,
        pay_url: checkout.pay_url,
        expires_at: checkout.expires_at,
      },
    };
  }

  private payments(context: ApiModuleContext, link: PaymentLink) {
    const now = context.clock().getTime();
    return context.docs
      .list<LinkSession>(NS_SESSIONS, link.id)
      .sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.token_id.localeCompare(b.token_id),
      )
      .map((session) => ({
        session_id: session.id,
        token_id: session.token_id,
        amount_usd: session.amount_usd,
        quantity: session.quantity,
        status:
          session.paid_at !== null
            ? "paid"
            : Date.parse(session.expires_at) < now
              ? "expired"
              : "open",
        paid_at: session.paid_at,
        expires_at: session.expires_at,
        created_at: session.created_at,
      }));
  }
}
