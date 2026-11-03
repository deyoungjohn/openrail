import { describe, expect, it } from "vitest";
import { onboardingSteps } from "./onboarding";

const NEAR = 10n ** 24n;
const business = {
  account_id: "acme.near",
  legal_name: "Acme Ltd",
  payout_account: "acme.near",
  contact_email: "ap@acme.example",
};

describe("onboardingSteps (blueprint 2.10: sign in, payout account, profile, storage credit, first invoice)", () => {
  it("a brand new business has only signed in", () => {
    const s = onboardingSteps({ business: null, creditYocto: 0n, invoiceCount: 0 });
    expect(s.steps.map((x) => [x.id, x.done])).toEqual([
      ["profile", false],
      ["payout", false],
      ["credit", false],
      ["invoice", false],
    ]);
    expect(s.next).toBe("profile");
    expect(s.complete).toBe(false);
  });

  it("each step is done by its own data", () => {
    const s = onboardingSteps({
      business: { ...business, payout_account: "" },
      creditYocto: NEAR,
      invoiceCount: 1,
    });
    expect(Object.fromEntries(s.steps.map((x) => [x.id, x.done]))).toEqual({
      profile: true,
      payout: false,
      credit: true,
      invoice: true,
    });
    expect(s.next).toBe("payout");
  });

  it("storage credit is done once it covers one invoice", () => {
    const low = onboardingSteps({ business, creditYocto: NEAR / 50n - 1n, invoiceCount: 0 });
    const ok = onboardingSteps({ business, creditYocto: NEAR / 50n, invoiceCount: 0 });
    expect(low.steps.find((x) => x.id === "credit")!.done).toBe(false);
    expect(ok.steps.find((x) => x.id === "credit")!.done).toBe(true);
  });

  it("is complete when every step is done", () => {
    const s = onboardingSteps({ business, creditYocto: NEAR, invoiceCount: 3 });
    expect(s.complete).toBe(true);
    expect(s.next).toBeNull();
  });

  it("an unknown amount (still loading) is never counted as done", () => {
    const s = onboardingSteps({ business, creditYocto: null, invoiceCount: null });
    expect(s.steps.find((x) => x.id === "credit")!.done).toBe(false);
    expect(s.steps.find((x) => x.id === "invoice")!.done).toBe(false);
  });
});
