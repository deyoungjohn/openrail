import { storageCreditLow } from "./near-amount";

export type OnboardingStepId = "profile" | "payout" | "credit" | "invoice";

export interface BusinessLike {
  legal_name: string;
  payout_account: string;
  contact_email: string;
}

/**
 * What is left before a business can get its first invoice paid. Each step is done by its own
 * data, so a returning person sees the real state. An unknown value (null, still loading) is never
 * counted as done.
 */
export function onboardingSteps(input: {
  business: BusinessLike | null;
  creditYocto: bigint | null;
  invoiceCount: number | null;
}): {
  steps: { id: OnboardingStepId; done: boolean }[];
  next: OnboardingStepId | null;
  complete: boolean;
} {
  const b = input.business;
  const steps: { id: OnboardingStepId; done: boolean }[] = [
    { id: "profile", done: !!b && b.legal_name.trim() !== "" && b.contact_email.trim() !== "" },
    { id: "payout", done: !!b && b.payout_account.trim() !== "" },
    { id: "credit", done: input.creditYocto !== null && !storageCreditLow(input.creditYocto) },
    { id: "invoice", done: input.invoiceCount !== null && input.invoiceCount > 0 },
  ];
  const next = steps.find((s) => !s.done)?.id ?? null;
  return { steps, next, complete: next === null };
}
