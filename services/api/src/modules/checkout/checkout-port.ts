/**
 * How payment links and `POST /v1/checkouts` create a Checkout claim: `issue_for` with the Checkout
 * kind, no debtor, and an expiry instead of a due date. One claim = one claim account, so every
 * payment is matched exactly.
 */
import { createHash } from "node:crypto";
import type { ApiModuleContext } from "../../modules.js";

export interface CheckoutInput {
  accountId: string;
  /** Two decimals, already validated and computed server-side. */
  amountUsd: string;
  orderRef: string;
  expiryMinutes: number;
  returnUrl?: string;
  itemsSha256?: string;
}

export interface CreatedCheckout {
  checkout_id: string;
  token_id: string;
  claim_account?: string;
  pay_url: string;
  expires_at: string;
}

export interface CheckoutPort {
  create(input: CheckoutInput): Promise<CreatedCheckout>;
}

/**
 * Claim kind number of Checkout. Fixed by the contract part of this module (REL-2); kept in one
 * place so the API and the contract agree.
 */
export const CHECKOUT_KIND = 1;

const EMPTY_ITEMS_SHA256 = createHash("sha256").update("[]").digest("hex");

function baseUnits(amountUsd: string): string {
  const [whole, cents = ""] = amountUsd.split(".");
  return (BigInt(whole ?? "0") * 1_000_000n + BigInt(cents.padEnd(6, "0").slice(0, 6))).toString();
}

/** Canonical terms of a checkout (`openrail.checkout.v1`), hashed on-chain as `terms_hash`. */
export function checkoutTerms(input: CheckoutInput, business: string, expiresAt: string) {
  return {
    schema: "openrail.checkout.v1",
    kind: "checkout",
    merchant: business,
    business,
    order_ref: input.orderRef,
    amount_usd: input.amountUsd,
    currency: "USD",
    expiry: Math.floor(Date.parse(expiresAt) / 1000),
    expires_at: expiresAt,
    items_sha256: input.itemsSha256 ?? EMPTY_ITEMS_SHA256,
  };
}

export function issuerCheckoutPort(context: ApiModuleContext): CheckoutPort {
  return {
    async create(input) {
      const expiresAt = new Date(context.clock().getTime() + input.expiryMinutes * 60_000);
      const expiresIso = expiresAt.toISOString();
      const prepared = await context.issuer.prepareIssue(input.accountId);
      const terms = checkoutTerms(input, input.accountId, expiresIso);
      const termsHash = createHash("sha256").update(JSON.stringify(terms)).digest("hex");
      const issued = await context.issuer.issueFor({
        business: input.accountId,
        kind: CHECKOUT_KIND,
        debtor: null,
        termsHash,
        amountDue: baseUnits(input.amountUsd),
        dueDate: Math.floor(expiresAt.getTime() / 1000),
        expectedTokenId: prepared.tokenId,
      });
      const tokenId = issued.tokenId ?? prepared.tokenId;
      const claimAccount = issued.claimAccount ?? prepared.claimAccount;
      return {
        checkout_id: tokenId,
        token_id: tokenId,
        claim_account: claimAccount,
        pay_url: `${context.config.payBaseUrl.replace(/\/+$/, "")}/c/${encodeURIComponent(tokenId)}`,
        expires_at: expiresIso,
      };
    },
  };
}

export const __test = { baseUnits };
