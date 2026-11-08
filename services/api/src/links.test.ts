import { describe, expect, it } from "vitest";
import { ackLink, businessSlug, payLink, refOf } from "./links.js";

describe("invoice links", () => {
  it("builds the pay link and the acceptance link from the business name and the invoice's own reference", () => {
    const ref = "9f3c2a7d41b86e0c15";
    expect(payLink("https://openrail.incepture.dev", "belmonte-studio", ref)).toBe(
      "https://openrail.incepture.dev/belmonte-studio/inv/9f3c2a7d41b86e0c15",
    );
    expect(ackLink("https://openrail.incepture.dev", "belmonte-studio", ref)).toBe(
      "https://openrail.incepture.dev/belmonte-studio/inv/ack/9f3c2a7d41b86e0c15",
    );
  });

  it("takes the reference from the invoice id", () => {
    expect(refOf("inv_9f3c2a7d41b86e0c15")).toBe("9f3c2a7d41b86e0c15");
  });

  describe("business slug", () => {
    it("is lowercase letters, digits and single hyphens", () => {
      expect(businessSlug("Belmonte Studio Ltd.", "belmonte.near")).toBe("belmonte-studio-ltd");
      expect(businessSlug("  Ünïcode & Co  ", "x.near")).toBe("unicode-co");
      expect(businessSlug("A---B", "x.near")).toBe("a-b");
    });
    it("falls back to the NEAR account when the name has no usable letters", () => {
      expect(businessSlug("日本", "belmonte.near")).toBe("belmonte-near");
      expect(businessSlug("", "acme.openrail.near")).toBe("acme-openrail-near");
    });
    it("is never a name the site already uses for a page", () => {
      for (const name of ["app", "pay", "ack", "r", "c", "api", "v1", "statement", "_next"])
        expect(businessSlug(name, "x.near")).not.toBe(name);
    });
    it("is at most 40 characters", () => {
      expect(businessSlug("a".repeat(100), "x.near").length).toBeLessThanOrEqual(40);
    });
  });
});
