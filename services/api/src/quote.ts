/** Pay-session quotes: allow-list, 1Click quote, then log_quote before the address. */
import { randomBytes } from "node:crypto";
import { assertAllowedRoute, type RouteFile } from "@openrail/shared";

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
  /** The merchant the claim was issued for (their business account), when the contract view says. */
  issuerId?: string;
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

export interface ProviderStatus {
  /** The provider's own word, e.g. PENDING_DEPOSIT, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED. */
  status: string;
  depositedAmount?: string;
  originChainTxHashes?: string[];
  destinationChainTxHashes?: string[];
  nearTxHashes?: string[];
}

export interface QuoteProvider {
  quote(request: QuoteProviderRequest): Promise<QuoteProviderResult>;
  /** What the provider says about a deposit address. Optional: without it the page shows the stored status. */
  status?(depositAddress: string): Promise<ProviderStatus>;
  /** Tells the provider the deposit transaction, so it does not have to find it: the payer's page ticks sooner. */
  submitDeposit?(txHash: string, depositAddress: string): Promise<void>;
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
  refundTo: string;
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
  status: "pending_deposit" | "processing" | "success" | "refunded" | "failed" | "expired";
  created_at: string;
}

export interface QuoteServiceDeps {
  routes: RouteFile;
  claim: (tokenId: string) => Promise<ClaimSnapshot>;
  provider: QuoteProvider;
  logger: QuoteLogger;
  clock?: () => Date;
  ids?: (prefix: string) => string;
  /**
   * Extra the payer is asked to send on a FLEX_INPUT route, in basis points of the amount. The provider's fee comes
   * out of what is sent, so a payer who sends exactly the price delivers a little less than it (a $10 payment from
   * Solana arrived as $9.999048 and left the order "partially paid" for $0.000952). Default 0: the amount is exact.
   */
  marginBps?: number;
  /** The destination asset the claim's issuer chose to be paid in, when they chose. */
  destinationFor?: (claim: ClaimSnapshot) => string | undefined;
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

/** Parse a USD string to base units without floating point. */
export function parseUsdToBaseUnits(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null)
    throw new QuoteError(400, "invalid_amount", "amount must be a decimal string");
  const whole = BigInt(match[1] ?? "0");
  const fractionText = match[2] ?? "";
  if (fractionText.length > decimals) {
    throw new QuoteError(400, "invalid_amount", "too many decimal places");
  }
  const fraction = BigInt((fractionText + "0".repeat(decimals)).slice(0, decimals) || "0");
  return whole * 10n ** BigInt(decimals) + fraction;
}

/** Display-only USD from 6-decimal base units; value math never uses this. */
export function formatUsdFromBaseUnits(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const fraction = (baseUnits % 1_000_000n) / 10_000n;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

/** Outstanding is USDC (6 decimals); convert exactly to an origin asset's decimals. */
export function usdcToOriginBaseUnits(outstanding: bigint, originDecimals: number): bigint {
  if (originDecimals >= 6) return outstanding * 10n ** BigInt(originDecimals - 6);
  return outstanding / 10n ** BigInt(6 - originDecimals);
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

  /** The provider's word about a deposit address, or nothing when the provider cannot say. */
  async status(depositAddress: string): Promise<ProviderStatus | undefined> {
    return this.deps.provider.status?.(depositAddress);
  }

  async submitDeposit(txHash: string, depositAddress: string): Promise<void> {
    await this.deps.provider.submitDeposit?.(txHash, depositAddress);
  }

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
    if (input.refundTo === "") throw new QuoteError(400, "invalid_refund_address");
    const claim = await this.deps.claim(input.tokenId);
    const now = this.clock();
    const deadlineSeconds = input.deadlineSeconds ?? claim.kindRules.quote_deadline ?? 3600;
    const deadlineRequested = Math.floor(now.getTime() / 1000) + deadlineSeconds;
    const requestedDeadline = new Date(deadlineRequested * 1000).toISOString();

    const decimals = route.swapType === "EXACT_OUTPUT" ? 6 : route.originDecimals;
    const outstanding = BigInt(claim.outstanding);
    if (input.amountUsd === undefined && outstanding === 0n)
      throw new QuoteError(409, "nothing_to_pay", "this invoice is already paid");
    const amountBaseUnits =
      input.amountUsd !== undefined
        ? parseUsdToBaseUnits(input.amountUsd, decimals)
        : route.swapType === "EXACT_OUTPUT"
          ? outstanding
          : usdcToOriginBaseUnits(outstanding, route.originDecimals);
    const amountUsd =
      input.amountUsd !== undefined
        ? formatUsdFromBaseUnits(parseUsdToBaseUnits(input.amountUsd, 6))
        : formatUsdFromBaseUnits(outstanding);
    const margin = BigInt(Math.max(0, Math.floor(this.deps.marginBps ?? 0)));
    const requested =
      route.swapType === "FLEX_INPUT" && margin > 0n
        ? (amountBaseUnits * (10_000n + margin) + 9_999n) / 10_000n
        : amountBaseUnits;
    const provider = await this.deps.provider.quote({
      originAsset: route.originAssetId,
      destinationAsset: this.deps.destinationFor?.(claim) ?? route.destinationAssetId,
      amount: requested.toString(),
      swapType: route.swapType,
      slippageTolerance: route.swapType === "EXACT_OUTPUT" ? 30 : 0,
      refundTo: input.refundTo,
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
      refundTo: input.refundTo,
      routeId: route.id,
    });

    return {
      id: this.ids("ps"),
      token_id: input.tokenId,
      route_id: route.id,
      quote_id: quoteId,
      deposit_address: provider.depositAddress,
      // The deadline promised to the payer is the one logged on chain; the provider keeps its own
      // deposit address open for three days after it.
      deadline: requestedDeadline,
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
