import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpenrailPayButton, isPaidMessage, payFrameUrl, payOrigin } from "./index.js";

describe("payFrameUrl", () => {
  it("builds the invoice pay URL on the pay origin and encodes the id", () => {
    expect(payFrameUrl("https://pay.example/", { invoice: "c-12" })).toBe(
      "https://pay.example/pay/c-12",
    );
    expect(payFrameUrl("https://pay.example", { invoice: "a/b?c" })).toBe(
      "https://pay.example/pay/a%2Fb%3Fc",
    );
  });
  it("accepts an absolute path on the same origin", () => {
    expect(payFrameUrl("https://pay.example", { path: "/pay/c-1?x=1" })).toBe(
      "https://pay.example/pay/c-1?x=1",
    );
  });
  it("needs exactly one of invoice or path", () => {
    expect(() => payFrameUrl("https://pay.example", {})).toThrow(/exactly one/);
    expect(() => payFrameUrl("https://pay.example", { invoice: "c-1", path: "/x" })).toThrow(
      /exactly one/,
    );
  });
  it("refuses paths that could leave the pay origin", () => {
    for (const path of [
      "//evil.example/x",
      "https://evil.example",
      "x",
      "/\\evil.example",
      "\\\\evil",
    ]) {
      expect(() => payFrameUrl("https://pay.example", { path })).toThrow();
    }
  });
  it("refuses non-http pay URLs", () => {
    expect(() => payOrigin("javascript:alert(1)")).toThrow(/http/);
    expect(() => payOrigin("not a url")).toThrow(/invalid/);
  });
});

describe("isPaidMessage", () => {
  const origin = "https://pay.example";
  it("accepts both message shapes from the pay origin", () => {
    expect(isPaidMessage({ origin, data: "openrail:payment-complete" }, origin)?.type).toBe(
      "openrail:payment-complete",
    );
    expect(
      isPaidMessage({ origin, data: { type: "openrail:paid", claim: "c-1" } }, origin),
    ).toEqual({
      type: "openrail:paid",
      claim: "c-1",
    });
  });
  it("ignores other origins and other messages", () => {
    expect(
      isPaidMessage({ origin: "https://evil.example", data: "openrail:payment-complete" }, origin),
    ).toBeNull();
    expect(isPaidMessage({ origin, data: { type: "other" } }, origin)).toBeNull();
    expect(isPaidMessage({ origin, data: null }, origin)).toBeNull();
    expect(isPaidMessage({ origin, data: 42 }, origin)).toBeNull();
  });
});

describe("OpenrailPayButton (server render)", () => {
  it("renders a closed, accessible button with the default label", () => {
    const html = renderToStaticMarkup(
      createElement(OpenrailPayButton, { payUrl: "https://pay.example", invoice: "c-1" }),
    );
    expect(html).toBe(
      '<button type="button" class="openrail-pay-button" aria-haspopup="dialog">Pay invoice</button>',
    );
  });
  it("renders custom content and class, and never an iframe before a click", () => {
    const html = renderToStaticMarkup(
      createElement(
        OpenrailPayButton,
        { payUrl: "https://pay.example", invoice: "c-1", className: "btn" },
        "Pay now",
      ),
    );
    expect(html).toContain('class="btn"');
    expect(html).toContain(">Pay now<");
    expect(html).not.toContain("iframe");
  });
  it("fails loudly on a bad configuration", () => {
    expect(() =>
      renderToStaticMarkup(
        createElement(OpenrailPayButton, { payUrl: "https://pay.example", path: "//evil.example" }),
      ),
    ).toThrow();
  });
});
