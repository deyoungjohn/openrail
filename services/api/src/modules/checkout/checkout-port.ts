/**
 * How payment links (and later `POST /v1/checkouts`) create a Checkout claim: `issue_for` with the
 * Checkout kind, no debtor, and an expiry instead of a due date. One claim = one claim account, so
 * every payment is matched exactly.
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
}

export interface CreatedCheckout {
  checkout_id: string;
  token_id: string;
  pay_url: string;
  expires_at: string;
}

export interface CheckoutPort {
  create(input: CheckoutInput): Promise<CreatedCheckout>;
}

/**
 * Claim kind number of Checkout. Fixed by the contract part of this module (REL-1); kept in one
 * place so the API and the contract agree.
 */
export const CHECKOUT_KIND = 1;

function baseUnits(amountUsd: string): string {
  const [whole, cents = ""] = amountUsd.split(".");
  return (BigInt(whole ?? "0") * 1_000_000n + BigInt(cents.padEnd(6, "0").slice(0, 6))).toString();
}

/** Canonical terms of a checkout, hashed on-chain as `terms_hash`. */
export function checkoutTerms(input: CheckoutInput, business: string, expiresAt: string) {
  return {
    kind: "checkout",
    business,
    order_ref: input.orderRef,
    amount_usd: input.amountUsd,
    currency: "USD",
    expires_at: expiresAt,
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
      await context.issuer.issueFor({
        business: input.accountId,
        kind: CHECKOUT_KIND,
        debtor: null,
        termsHash,
        amountDue: baseUnits(input.amountUsd),
        dueDate: Math.floor(expiresAt.getTime() / 1000),
      });
      return {
        checkout_id: prepared.tokenId,
        token_id: prepared.tokenId,
        pay_url: `${context.config.payBaseUrl.replace(/\/+$/, "")}/c/${encodeURIComponent(prepared.tokenId)}`,
        expires_at: expiresIso,
      };
    },
  };
}

export const __test = { baseUnits };
