/**
 * How payment links and `POST /v1/checkouts` create a Checkout claim: `issue_for` with the Checkout
 * kind, no debtor, and an expiry instead of a due date. One claim = one claim account, so every
 * payment is matched exactly.
 */
import { randomBytes } from "node:crypto";
import { ApiError } from "../../app.js";
import { sha256Hex0x } from "../../crypto.js";
import { claimLabel } from "../../links.js";
import { canonicalJson } from "../../terms.js";
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

export const EMPTY_ITEMS_SHA256 = sha256Hex0x("[]");

function baseUnits(amountUsd: string): string {
  const [whole, cents = ""] = amountUsd.split(".");
  return (BigInt(whole ?? "0") * 1_000_000n + BigInt(cents.padEnd(6, "0").slice(0, 6))).toString();
}

/**
 * Canonical terms of a checkout (`openrail.checkout.v1`), per blueprint modules/checkout.md:
 * merchant, order_ref, amount_usd, expiry, items_sha256.
 * Hashed on-chain as `terms_hash` (0x + 64 lower hex).
 */
export interface CheckoutTerms {
  amount_usd: string;
  expiry: number;
  items_sha256: string;
  merchant: string;
  order_ref: string;
}

export function checkoutTerms(
  input: CheckoutInput,
  merchant: string,
  expiry: number,
  itemsSha256?: string,
): CheckoutTerms {
  return {
    amount_usd: input.amountUsd,
    expiry,
    items_sha256: itemsSha256 ?? EMPTY_ITEMS_SHA256,
    merchant,
    order_ref: input.orderRef,
  };
}

export function canonicalCheckoutTerms(terms: CheckoutTerms): string {
  return canonicalJson({
    amount_usd: terms.amount_usd,
    expiry: terms.expiry,
    items_sha256: terms.items_sha256,
    merchant: terms.merchant,
    order_ref: terms.order_ref,
  });
}

export function checkoutTermsHash(terms: CheckoutTerms): string {
  return sha256Hex0x(canonicalCheckoutTerms(terms));
}

export function issuerCheckoutPort(context: ApiModuleContext): CheckoutPort {
  return {
    async create(input) {
      const expiresAt = new Date(context.clock().getTime() + input.expiryMinutes * 60_000);
      const expiresIso = expiresAt.toISOString();
      const expiry = Math.floor(expiresAt.getTime() / 1000);
      const itemsSha256 = input.itemsSha256 ?? EMPTY_ITEMS_SHA256;
      const terms = checkoutTerms(input, input.accountId, expiry, itemsSha256);
      const termsHash = checkoutTermsHash(terms);

      const labels = context.config.claimLabels === true;
      let label: string | undefined;
      let knownClaimAccount: string | undefined;

      if (labels) {
        const business = context.store.getBusiness(input.accountId);
        const username = business?.username || input.accountId;
        const randomRef = randomBytes(9).toString("hex");
        label = claimLabel(username, randomRef);
        knownClaimAccount = `${label}.${context.config.rootAccount}`;
      }

      const prepared = await context.issuer.prepareIssue(input.accountId);
      const claimAccount = (knownClaimAccount ?? prepared.claimAccount) as string | undefined;
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
          "the issuer service did not report the next token id",
        );
      }

      const issued = await context.issuer.issueFor({
        business: input.accountId,
        kind: CHECKOUT_KIND,
        debtor: null,
        termsHash,
        amountDue: baseUnits(input.amountUsd),
        dueDate: expiry,
        ...(labels
          ? { claimLabel: label as string }
          : { expectedTokenId: prepared.tokenId as string }),
      });

      const tokenId = (labels ? (label as string) : (issued.tokenId ?? prepared.tokenId)) as string;
      const finalClaimAccount = (
        labels ? knownClaimAccount : (issued.claimAccount ?? claimAccount)
      ) as string;

      return {
        checkout_id: tokenId,
        token_id: tokenId,
        claim_account: finalClaimAccount,
        pay_url: `${context.config.payBaseUrl.replace(/\/+$/, "")}/c/${encodeURIComponent(tokenId)}`,
        expires_at: expiresIso,
      };
    },
  };
}

export const __test = { baseUnits };
