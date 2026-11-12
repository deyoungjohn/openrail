"use client";

import type { Business } from "@openrail/api-client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { isNearAccountId } from "@/lib/near-account";
import { enabledModules } from "@/enabled";
import { collectSettingsSections } from "@/lib/module-settings";
import { useStorageCredit } from "@/lib/use-storage-credit";
import { useAsync } from "@/lib/use-async";
import { AccountBar } from "../auth/account-bar";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { DEFAULT_SETTLEMENT, SettlementSelect } from "./settlement-select";
import { Tabs } from "../ui/tabs";
import { ErrorState } from "../ui/state";
import { StorageCreditCard } from "./storage-credit-card";
import { ErrorNote } from "@/components/ui/error-note";

const moduleSettingsSections = collectSettingsSections(enabledModules);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ProfileCard({
  business,
  onSaved,
}: {
  business: Business;
  onSaved: (b: Business) => void;
}) {
  const t = copy.setup;
  const s = copy.settings;
  const [name, setName] = useState(business.legal_name);
  const [payout, setPayout] = useState(business.payout_account);
  const [email, setEmail] = useState(business.contact_email);
  const [asset, setAsset] = useState(business.settlement_asset || DEFAULT_SETTLEMENT);
  const [shown, setShown] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const changed: Record<string, string> = {};
  if (name.trim() !== business.legal_name) changed.legal_name = name.trim();
  if (payout.trim() !== business.payout_account) changed.payout_account = payout.trim();
  if (email.trim() !== business.contact_email) changed.contact_email = email.trim();
  if (asset !== (business.settlement_asset || DEFAULT_SETTLEMENT)) changed.settlement_asset = asset;
  const dirty = Object.keys(changed).length > 0;

  const nameBad = name.trim() === "";
  const payoutBad = !isNearAccountId(payout.trim());
  const emailBad = !EMAIL.test(email.trim());

  useEffect(() => {
    if (dirty && state === "saved") setState("idle");
  }, [dirty, state]);

  return (
    <Card title={s.profileTitle}>
      <form
        noValidate
        className="space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setShown(true);
          if (!dirty || nameBad || payoutBad || emailBad) return;
          setState("saving");
          try {
            onSaved(await dashClient.business.update(changed));
            setState("saved");
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
          label={t.payoutAccount}
          value={payout}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setPayout(e.target.value.trim())}
          error={shown && payoutBad ? t.badAccount : undefined}
        />
        <Input
          label={t.contactEmail}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={shown && emailBad ? t.badEmail : undefined}
        />
        <SettlementSelect value={asset} onChange={setAsset} />
        <ErrorNote>{state === "failed" ? s.saveFailed : null}</ErrorNote>
        <div className="flex items-center justify-center gap-3">
          <Button type="submit" disabled={!dirty} loading={state === "saving"}>
            {state === "saving" ? s.saving : s.save}
          </Button>
          {state === "saved" ? (
            <span role="status" className="text-[14px] font-medium">
              {t.saved}
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

export function SettingsScreen() {
  const s = copy.settings;
  const [biz, reload] = useAsync(() => dashClient.business.get(), []);
  const [credit, , watchCredit] = useStorageCredit();
  const [saved, setSaved] = useState<Business | null>(null);

  const business = saved ?? (biz.state === "ready" ? biz.data : null);

  const general = (
    <div className="space-y-6">
      {biz.state === "loading" ? <Card state="loading" /> : null}
      {biz.state === "error" ? (
        <div className="surface-card">
          <ErrorState body={s.loadError} onRetry={reload} />
        </div>
      ) : null}
      {business ? (
        <ProfileCard key={business.updated_at} business={business} onSaved={setSaved} />
      ) : null}

      <StorageCreditCard credit={credit} reload={watchCredit} />

      <Card title={s.signedInTitle}>
        <AccountBar />
      </Card>

      <Card title={copy.setup.title}>
        <p className="caption mb-3">{s.setupHelp}</p>
        <Link href="/app/onboarding">
          <Button variant="secondary">{s.openSetup}</Button>
        </Link>
      </Card>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-[32px] leading-10 font-bold">{s.title}</h1>
      {moduleSettingsSections.length === 0 ? (
        general
      ) : (
        <Tabs
          label={s.title}
          items={[
            { id: "general", label: s.generalTab, panel: general },
            ...moduleSettingsSections.map(({ id, label, Panel }) => ({
              id,
              label,
              panel: <Panel />,
            })),
          ]}
        />
      )}
    </div>
  );
}
