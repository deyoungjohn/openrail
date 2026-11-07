import { describe, expect, it } from "vitest";
import {
  canQuoteCheckout,
  checkoutLiveBanner,
  checkoutStatusLabel,
  countdownTargetMs,
  safeReturnUrl,
  type PublicCheckout,
} from "./checkout";

const base = (over: Partial<PublicCheckout> = {}): PublicCheckout => ({
  id: "c-101",
  token_id: "c-101",
  claim_account: "c-101.claims.openrail.near",
  merchant: "acme.openrail.near",
  order_ref: "ORD-1",
  amount_usd: "2.00",
  amount_due: "2000000",
  outstanding: "2000000",
  paid_total: "0",
  surplus: "0",
  status: "pending",
  expires_at: "2026-11-10T10:15:00.000Z",
  return_url: "https://shop.example/done",
  ...over,
});

describe("checkout hosted page rules", () => {
  it("checkout_countdown_uses_requested_deadline", () => {
    // The provider keeps its deposit address open for three days beyond what we ask for;
    // the countdown shown to a payer uses the on-chain `deadline_requested` (unix seconds).
    const requestedUnix = 1_762_769_700;
    const providerThreeDaysLater = "2026-11-13T10:15:00.000Z";
    expect(
      countdownTargetMs({
        deadline_requested: requestedUnix,
        deadline: providerThreeDaysLater,
      }),
    ).toBe(requestedUnix * 1000);
    // And for the checkout itself before a quote is asked for, it uses the checkout's expiry.
    expect(countdownTargetMs({ expires_at: "2026-11-10T10:15:00.000Z" })).toBe(
      Date.parse("2026-11-10T10:15:00.000Z"),
    );
  });

  it("checkout_no_quote_after_expiry", () => {
    const expiryMs = Date.parse("2026-11-10T10:15:00.000Z");
    expect(canQuoteCheckout(base(), expiryMs - 1000)).toBe(true);
    expect(
      canQuoteCheckout(base({ status: "partial", outstanding: "1000000" }), expiryMs - 1000),
    ).toBe(true);
    expect(canQuoteCheckout(base(), expiryMs)).toBe(false);
    expect(canQuoteCheckout(base({ status: "expired" }), expiryMs - 60_000)).toBe(false);
    expect(canQuoteCheckout(base({ status: "paid", outstanding: "0" }), expiryMs - 60_000)).toBe(
      false,
    );
    expect(canQuoteCheckout(base({ status: "late", outstanding: "0" }), expiryMs - 60_000)).toBe(
      false,
    );
    expect(
      canQuoteCheckout(base({ status: "refunded", outstanding: "0" }), expiryMs - 60_000),
    ).toBe(false);
  });

  it("checkout_paid_only_on_full_amount", () => {
    const partial = base({ status: "partial", outstanding: "1000000", paid_total: "1000000" });
    expect(checkoutStatusLabel(partial)).toContain("$1.00");
    expect(checkoutStatusLabel(partial).toLowerCase()).not.toBe("paid");
    expect(checkoutStatusLabel(base({ status: "paid", outstanding: "0" }))).toBe("Paid");
  });

  it("pos_shows_settling_on_origin_seen", () => {
    // As soon as the payer's transaction is seen (`processing`), the page shows "received, settling".
    const waiting = checkoutLiveBanner(base(), "waiting");
    expect(waiting.kind).toBe("waiting");
    const settling = checkoutLiveBanner(base(), "processing");
    expect(settling.kind).toBe("settling");
    expect(settling.title.toLowerCase()).toContain("received");
    expect(settling.title.toLowerCase()).toContain("settling");
    const paid = checkoutLiveBanner(base({ status: "paid", outstanding: "0" }), "paid");
    expect(paid.kind).toBe("paid");
  });

  it("checkout_live_banner_covers_partial_late_expired_accepted_and_refunded", () => {
    const partial = checkoutLiveBanner(
      base({ status: "partial", outstanding: "1000000", paid_total: "1000000" }),
      null,
    );
    expect(partial.kind).toBe("partial");
    expect(partial.body).toContain("$1.00");
    expect(checkoutLiveBanner(base({ status: "late" }), null).kind).toBe("late");
    expect(checkoutLiveBanner(base({ status: "accepted" }), null).kind).toBe("paid");
    expect(checkoutLiveBanner(base({ status: "refunded" }), null).kind).toBe("refunded");
    expect(checkoutLiveBanner(base({ status: "expired" }), null).kind).toBe("expired");
    expect(checkoutLiveBanner(base({ status: "needs_attention" }), null).kind).toBe("late");
    expect(checkoutStatusLabel(base({ status: "needs_attention" }))).toContain("attention");
    expect(canQuoteCheckout(base({ status: "needs_attention" }), 0)).toBe(false);
  });

  it("checkout_return_url_only_allows_https", () => {
    expect(safeReturnUrl("https://shop.example/thanks?order=1")).toBe(
      "https://shop.example/thanks?order=1",
    );
    expect(safeReturnUrl("http://shop.example/thanks")).toBeNull();
    expect(safeReturnUrl("javascript:alert(1)")).toBeNull();
    expect(safeReturnUrl(null)).toBeNull();
    expect(safeReturnUrl(undefined)).toBeNull();
  });
});
