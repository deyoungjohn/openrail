import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copy } from "../../copy";
import {
  canQuoteCheckout,
  checkoutCopy,
  checkoutLiveBanner,
  checkoutPayWords,
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

  it("checkout_fee_mode_breakdown_label", () => {
    expect(checkoutCopy.feeBreakdown("12.00", "0.03", "12.03")).toBe(
      "Order $12.00 + Processing fee (0.25%) $0.03 = $12.03",
    );
  });
});

describe("a checkout is not an invoice: the hosted page never says invoice", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const screen = readFileSync(join(here, "checkout-screen.tsx"), "utf8");

  const text = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : typeof value === "function"
        ? [String((value as (...a: string[]) => unknown)("x", "y", "z", "w"))]
        : value !== null && typeof value === "object"
          ? Object.values(value as Record<string, unknown>).flatMap(text)
          : [];

  it("checkout_copy_has_no_invoice_word", () => {
    expect(text(checkoutCopy).filter((t) => /invoice/i.test(t))).toEqual([]);
  });

  it("checkout_pay_flow_says_no_invoice: every shared string the flow uses is either free of the word or overridden", () => {
    const flow = readFileSync(join(here, "../../components/pay/pay-screen.tsx"), "utf8");
    const keys = [...new Set([...flow.matchAll(/\bp\.([A-Za-z]+)/g)].map((m) => m[1] as string))];
    const words = { ...copy.pay, ...checkoutPayWords } as unknown as Record<string, unknown>;
    const offenders = keys.filter((k) => text(words[k]).some((t) => /invoice/i.test(t)));
    expect(offenders).toEqual([]);
  });

  it("checkout_screen_source_has_no_invoice_word_in_its_own_text", () => {
    const literal = [...screen.matchAll(/"([^"\n]*)"|>([^<>{}\n]+)</g)]
      .map((m) => m[1] ?? m[2] ?? "")
      .filter((t) => /invoice/i.test(t));
    expect(literal).toEqual([]);
  });
});
