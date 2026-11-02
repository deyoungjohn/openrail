/** Pay-session quotes: allow-list, 1Click quote, then log_quote before the address. */
import { assertAllowedRoute, usdToBaseUnits, type RouteFile } from "@openrail/shared";

export interface KindRules {
  ack_required_for_sale: boolean;
  sellable: boolean;
  quote_deadline: number;
  debtor_optional: boolean;
}

export interface ClaimSnapshot {
  tokenId: string;
  claimAccount: string;
  termsHash: string;
  outstanding: string;
  amountDue: string;
  kindRules: KindRules;
}

export interface QuoteProviderRequest {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  swapType: "FLEX_INPUT" | "EXACT_OUTPUT";
  slippageTolerance: number;
  refundTo: string;
  recipient: string;
  deadline: string;
}

export interface QuoteProviderResult {
  quoteId: string;
  depositAddress: string;
  deadline: string;
  amountIn: string;
  amountOut: string;
  spreadBps?: number;
}

export interface QuoteProvider {
  quote(request: QuoteProviderRequest): Promise<QuoteProviderResult>;
}

export interface QuoteLogger {
  logQuote(request: {
    tokenId: string;
    quoteId: string;
    depositAddress: string;
    deadlineRequested: number;
    refundTo: string;
    routeId: string;
  }): Promise<{ txHash: string }>;
}

export interface PaySessionInput {
  tokenId: string;
  routeId: string;
  amountUsd?: string;
  refundTo?: string;
  deadlineSeconds?: number;
}

export interface PaySession {
  id: string;
  token_id: string;
  route_id: string;
  quote_id: string;
  deposit_address: string;
  deadline: string;
  deadline_requested: number;
  amount_in: string;
  amount_out: string;
  amount_usd: string;
  spread_bps: number;
  claim_account: string;
  terms_hash: string;
  status: "pending_deposit";
  created_at: string;
}

export interface QuoteServiceDeps {
  routes: RouteFile;
  claim: (tokenId: string) => Promise<ClaimSnapshot>;
  provider: QuoteProvider;
  logger: QuoteLogger;
  clock?: () => Date;
  ids?: (prefix: string) => string;
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

function money(amount: string): string {
  const value = BigInt(amount);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${fraction}`;
}

export class QuoteError extends Error {
  override readonly name = "QuoteError";
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isQuoteExpired(deadline: string, now = new Date()): boolean {
  return new Date(deadline).getTime() <= now.getTime();
}

export class QuoteService {
  private readonly clock: () => Date;
  private readonly ids: (prefix: string) => string;

  constructor(private readonly deps: QuoteServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.ids = deps.ids ?? id;
  }

  async createSession(input: PaySessionInput): Promise<PaySession> {
    let route;
    try {
      route = assertAllowedRoute(input.routeId, this.deps.routes);
    } catch {
      throw new QuoteError(400, "unknown_route", `route ${input.routeId} is not allow-listed`);
    }
    const claim = await this.deps.claim(input.tokenId);
    const now = this.clock();
    const deadlineSeconds = input.deadlineSeconds ?? claim.kindRules.quote_deadline ?? 3600;
    const deadlineRequested = Math.floor(now.getTime() / 1000) + deadlineSeconds;
    const requestedDeadline = new Date(deadlineRequested * 1000).toISOString();

    const amountUsd = input.amountUsd ?? money(claim.outstanding);
    const amount = usdToBaseUnits(
      Number(amountUsd),
      route.swapType === "EXACT_OUTPUT" ? 6 : route.originDecimals,
    );
    const provider = await this.deps.provider.quote({
      originAsset: route.originAssetId,
      destinationAsset: route.destinationAssetId,
      amount: amount.toString(),
      swapType: route.swapType,
      slippageTolerance: route.swapType === "EXACT_OUTPUT" ? 30 : 0,
      refundTo: input.refundTo ?? "",
      recipient: claim.claimAccount,
      deadline: requestedDeadline,
    });
    if (provider.depositAddress === "") {
      throw new QuoteError(502, "quote_failed", "provider returned no deposit address");
    }

    const quoteId = provider.quoteId === "" ? this.ids("q") : provider.quoteId;
    // Blueprint 2.8: log_quote must succeed before the deposit address is returned.
    await this.deps.logger.logQuote({
      tokenId: input.tokenId,
      quoteId,
      depositAddress: provider.depositAddress,
      deadlineRequested,
      refundTo: input.refundTo ?? "",
      routeId: route.id,
    });

    return {
      id: this.ids("ps"),
      token_id: input.tokenId,
      route_id: route.id,
      quote_id: quoteId,
      deposit_address: provider.depositAddress,
      deadline: provider.deadline,
      deadline_requested: deadlineRequested,
      amount_in: provider.amountIn,
      amount_out: provider.amountOut,
      amount_usd: amountUsd,
      spread_bps: provider.spreadBps ?? 0,
      claim_account: claim.claimAccount,
      terms_hash: claim.termsHash,
      status: "pending_deposit",
      created_at: now.toISOString(),
    };
  }
}
