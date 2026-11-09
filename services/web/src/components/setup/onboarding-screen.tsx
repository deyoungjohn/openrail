"use client";

import type { Business } from "@openrail/api-client";
import { ApiError } from "@openrail/api-client";
import { Check } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { isNearAccountId } from "@/lib/near-account";
import { onboardingSteps, type OnboardingStepId } from "@/lib/onboarding";
import { useStorageCredit } from "@/lib/use-storage-credit";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/cn";
import { useAuth } from "../auth/auth-provider";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { ErrorState, Skeleton } from "../ui/state";
import { AccountId } from "../ui/account-id";
import { StorageCreditCard } from "./storage-credit-card";
import { ErrorNote } from "@/components/ui/error-note";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ProfileForm({ business, onSaved }: { business: Business | null; onSaved: () => void }) {
  const t = copy.setup;
  const [name, setName] = useState(business?.legal_name ?? "");
  const [email, setEmail] = useState(business?.contact_email ?? "");
  const [shown, setShown] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const nameBad = name.trim() === "";
  const emailBad = !EMAIL.test(email.trim());

  return (
    <form
      noValidate
      className="mt-4 space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setShown(true);
        if (nameBad || emailBad) return;
        setState("saving");
        try {
          await dashClient.business.update({
            legal_name: name.trim(),
            contact_email: email.trim(),
          });
          onSaved();
        } catch {
          setState("failed");
        }
      }}
    >
      <Input
        label={t.businessName}
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={shown && nameBad ? t.badName : undefined}
      />
      <Input
        label={t.contactEmail}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={shown && emailBad ? t.badEmail : undefined}
      />
      <ErrorNote>{state === "failed" ? t.saveFailed : null}</ErrorNote>
      <div className="flex justify-center">
        <Button type="submit" loading={state === "saving"}>
          {t.saveProfile}
        </Button>
      </div>
    </form>
  );
}

function PayoutForm({ initial, onSaved }: { initial: string; onSaved: () => void }) {
  const t = copy.setup;
  const [value, setValue] = useState(initial);
  const [shown, setShown] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const bad = !isNearAccountId(value.trim());

  return (
    <form
      noValidate
      className="mt-4 space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setShown(true);
        if (bad) return;
        setState("saving");
        try {
          await dashClient.business.update({ payout_account: value.trim() });
          onSaved();
        } catch {
          setState("failed");
        }
      }}
    >
      <Input
        label={t.payoutAccount}
        value={value}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value.trim())}
        error={shown && bad ? t.badAccount : undefined}
      />
      <ErrorNote>{state === "failed" ? t.saveFailed : null}</ErrorNote>
      <div className="flex justify-center">
        <Button type="submit" loading={state === "saving"}>
          {t.savePayout}
        </Button>
      </div>
    </form>
  );
}

export function OnboardingScreen() {
  const t = copy.setup;
  const auth = useAuth();
  const account = auth.state.status === "signedIn" ? auth.state.accountId : "";
  const [biz, reloadBiz] = useAsync<Business | null>(
    () =>
      dashClient.business.get().catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }),
    [],
  );
  const [credit, , watchCredit] = useStorageCredit();
  const [invoices] = useAsync(() => dashClient.invoices.list({ limit: 1 }), []);

  if (biz.state === "error")
    return (
      <div className="mx-auto max-w-3xl">
        <div className="surface-card">
          <ErrorState body={t.loadError} onRetry={reloadBiz} />
        </div>
      </div>
    );

  const business = biz.state === "ready" ? biz.data : null;
  const loading = biz.state === "loading";
  const { steps, next, complete } = onboardingSteps({
    business,
    creditYocto: credit.state === "ready" ? BigInt(credit.data.balance) : null,
    invoiceCount: invoices.state === "ready" ? invoices.data.data.length : null,
  });

  const heading: Record<OnboardingStepId, { title: string; body: string }> = {
    profile: { title: t.profile, body: t.profileBody },
    payout: { title: t.payout, body: t.payoutBody },
    credit: { title: t.credit, body: t.creditBody },
    invoice: { title: t.invoice, body: t.invoiceBody },
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-[32px] leading-10 font-bold">{t.title}</h1>
        <p className="text-[15px]">{t.intro}</p>
      </header>

      {complete ? (
        <div role="status" className="surface-card space-y-2 p-6">
          <p className="text-[18px] font-semibold">{t.ready}</p>
          <p className="text-[15px]">{t.readyBody}</p>
        </div>
      ) : null}

      {loading ? (
        <Card state="loading" />
      ) : (
        <ol aria-label={t.stepsLabel} className="space-y-4">
          {steps.map((s, i) => {
            const open = next === s.id;
            return (
              <li key={s.id} className={cn("surface-card p-6")}>
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-full border text-[13px] font-medium",
                      s.done
                        ? "border-success bg-surface text-success-text"
                        : open
                          ? "border-accent text-accent-text"
                          : "border-border text-muted",
                    )}
                  >
                    {s.done ? <Check size={16} strokeWidth={1.5} /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[18px] leading-[26px] font-semibold">
                        {heading[s.id].title}
                      </h2>
                      <span className="caption">{s.done ? t.done : open ? t.next : t.later}</span>
                    </div>
                    <p className="caption">{heading[s.id].body}</p>

                    {s.id === "profile" && s.done && business ? (
                      <p className="mt-2 text-[14px]">
                        {t.summaryProfile(business.legal_name, business.contact_email)}
                      </p>
                    ) : null}
                    {s.id === "payout" && s.done && business ? (
                      <p className="mt-2 text-[14px]">
                        <AccountId value={business.payout_account} />
                      </p>
                    ) : null}

                    {open && s.id === "profile" ? (
                      <ProfileForm business={business} onSaved={reloadBiz} />
                    ) : null}
                    {open && s.id === "payout" ? (
                      <PayoutForm
                        initial={business?.payout_account || account}
                        onSaved={reloadBiz}
                      />
                    ) : null}
                    {open && s.id === "credit" ? (
                      <div className="mt-4">
                        <StorageCreditCard credit={credit} reload={watchCredit} />
                      </div>
                    ) : null}
                    {open && s.id === "invoice" ? (
                      <p className="mt-4">
                        <Link href="/app/invoices/new">
                          <Button>{t.createFirst}</Button>
                        </Link>
                      </p>
                    ) : null}
                    {s.id === "credit" && !open && credit.state === "loading" ? (
                      <Skeleton className="mt-2 h-4 w-24" />
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
