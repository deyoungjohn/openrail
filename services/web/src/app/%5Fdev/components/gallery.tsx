"use client";

import { Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AddressChip, TxLink } from "@/components/ui/address-chip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChainBadge, type ChainId } from "@/components/ui/chain-badge";
import { Countdown } from "@/components/ui/countdown";
import { Input, Select } from "@/components/ui/input";
import { KpiTile } from "@/components/ui/kpi-tile";
import { Modal } from "@/components/ui/modal";
import { QrPanel } from "@/components/ui/qr-panel";
import { StatusChip, type Status } from "@/components/ui/status-chip";
import { Table, type Column } from "@/components/ui/table";
import { Tabs } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Timeline } from "@/components/ui/timeline";
import { useToast } from "@/components/ui/toast";
import { AccountId } from "@/components/ui/account-id";
import { WalletPicker } from "@/components/wallet-picker";
import { EvmWalletView, NearWalletView } from "@/components/wallet-buttons";
import type { NearWalletInfo } from "@/wallet/near";
import { formatUsd } from "@/lib/format";

// Fixed values so screenshots are stable. The hash and address are made up for display.
const HASH = "0x1bfc8f2d4e6a90b7c3d5e1f8a2b4c6d8e0f1a3b5c7d9e2f4a6b8c0d2e4f6a603";
const ADDR = "0x9A4e0B3c5D7f1E2a4B6c8D0e2F4a6B8c0D2e4F6a";
const NOW = 1_800_000_000_000;
const noop = () => {};
const IMPLICIT = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";
const pickerWallets: NearWalletInfo[] = [
  {
    id: "meteor-wallet",
    name: "Meteor Wallet",
    iconUrl: null,
    type: "injected",
    available: true,
    signsMessage: true,
  },
  {
    id: "hot-wallet",
    name: "HOT Wallet",
    iconUrl: null,
    type: "injected",
    available: true,
    signsMessage: false,
  },
  {
    id: "okx-wallet",
    name: "OKX Wallet",
    iconUrl: null,
    type: "injected",
    available: true,
    signsMessage: null,
  },
  {
    id: "coin98-wallet",
    name: "Coin98 Wallet",
    iconUrl: null,
    type: "injected",
    available: false,
    signsMessage: null,
  },
];

const statuses: Status[] = [
  { kind: "draft" },
  { kind: "sent" },
  { kind: "acknowledged" },
  { kind: "partial", due: "$40.00" },
  { kind: "paid" },
  { kind: "overdue", days: 3 },
  { kind: "closed" },
  { kind: "cancelled" },
  { kind: "late" },
];

interface Row {
  id: string;
  client: string;
  status: Status;
  cents: bigint;
}
const rows: Row[] = [
  { id: "INV-0001", client: "Northwind Studio", status: { kind: "paid" }, cents: 250000n },
  { id: "INV-0002", client: "Fabrikam Labs", status: { kind: "sent" }, cents: 123456n },
  { id: "INV-0003", client: "Contoso Design", status: { kind: "overdue", days: 3 }, cents: 9900n },
];
const columns: Column<Row>[] = [
  {
    key: "id",
    header: "Number",
    render: (r) => <code className="font-mono text-[13px] text-accent">{r.id}</code>,
  },
  { key: "client", header: "Client", render: (r) => r.client },
  { key: "status", header: "Status", render: (r) => <StatusChip status={r.status} /> },
  { key: "amount", header: "Amount", align: "right", render: (r) => formatUsd(r.cents) },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-[24px] leading-8 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function Gallery() {
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [picker, setPicker] = useState(false);
  const [chain, setChain] = useState<ChainId>("base");
  const toast = useToast();

  return (
    <main className="mx-auto max-w-[1280px] space-y-12 px-4 py-8">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-[32px] leading-10 font-bold">Components</h1>
        <ThemeToggle />
      </header>

      <Section title="Buttons">
        <div className="flex flex-wrap gap-3">
          <Button>Send invoice</Button>
          <Button variant="secondary">Copy pay link</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Cancel invoice</Button>
          <Button size="sm">Small</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Inputs">
        <div className="grid gap-6 md:grid-cols-3">
          <Input
            label="Client"
            placeholder="Search clients"
            icon={<Search size={18} strokeWidth={1.5} />}
            helper="Pick a client or add a new one."
          />
          <Input label="Invoice number" defaultValue="INV-0004" />
          <Input label="Due date" error="Pick a date after the issue date." />
          <Select label="Currency" defaultValue="usd" helper="Invoices are in USD.">
            <option value="usd">USD</option>
          </Select>
          <Input label="Loading" loading />
        </div>
      </Section>

      <Section title="Cards and KPI tiles">
        <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="Outstanding" cents={780050n} deltaPct={1.5} />
          <KpiTile label="Overdue" cents={12000n} deltaPct={-4.2} />
          <KpiTile label="Collected" state="loading" />
          <KpiTile label="Average time to get paid" state="error" />
        </div>
        <div className="grid items-start gap-4 md:grid-cols-4">
          <Card title="Ready" info="What this card shows">
            Content
          </Card>
          <Card title="Loading" state="loading" />
          <Card title="Empty" state="empty" emptyBody="Payments show up here." />
          <Card title="Error" state="error" onRetry={() => {}} />
        </div>
      </Section>

      <Section title="Status chips">
        <div className="flex flex-wrap gap-2">
          {statuses.map((s) => (
            <StatusChip key={s.kind} status={s} />
          ))}
        </div>
      </Section>

      <Section title="Tabs with counts">
        <Tabs
          label="Invoice status"
          items={[
            { id: "all", label: "All", count: 25, panel: <p>All invoices</p> },
            { id: "paid", label: "Paid", count: 12, panel: <p>Paid invoices</p> },
            { id: "pending", label: "Pending", count: 9, panel: <p>Pending invoices</p> },
            { id: "overdue", label: "Overdue", count: 4, panel: <p>Overdue invoices</p> },
          ]}
        />
      </Section>

      <Section title="Table: ready, loading, empty, error">
        <Table
          caption="Invoices"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          page={{ from: 1, to: 3, total: 114, onNext: () => {} }}
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <Table
            caption="Invoices"
            columns={columns}
            rows={[]}
            rowKey={(r) => r.id}
            state="loading"
          />
          <Table
            caption="Invoices"
            columns={columns}
            rows={[]}
            rowKey={(r) => r.id}
            state="empty"
            emptyTitle="No invoices yet"
            emptyBody="Create your first invoice to get paid."
            emptyAction={<Button>Create invoice</Button>}
          />
          <Table
            caption="Invoices"
            columns={columns}
            rows={[]}
            rowKey={(r) => r.id}
            state="error"
            onRetry={() => {}}
          />
        </div>
      </Section>

      <Section title="Addresses, transactions and chains">
        <div className="flex flex-wrap items-center gap-6">
          <AddressChip value={ADDR} chain="ethereum" />
          <TxLink value={HASH} chain="base" href={`https://basescan.org/tx/${HASH}`} />
        </div>
        <div className="flex flex-wrap gap-2">
          {(["base", "arbitrum", "optimism", "polygon", "solana"] as const).map((c) => (
            <ChainBadge key={c} chain={c} selected={chain === c} onSelect={() => setChain(c)} />
          ))}
          <ChainBadge chain="near" />
        </div>
      </Section>

      <Section title="Timeline and countdown">
        <div className="grid gap-6 md:grid-cols-3">
          <Card title="Ready">
            <Timeline
              steps={[
                {
                  id: "1",
                  title: "Payment sent",
                  status: "done",
                  time: "12:01:04",
                  txs: <TxLink value={HASH} chain="base" />,
                },
                { id: "2", title: "Payment received", status: "done", time: "12:01:21" },
                { id: "3", title: "Paid out", status: "current" },
                { id: "4", title: "Receipt ready", status: "todo" },
              ]}
            />
          </Card>
          <Card title="Loading">
            <Timeline steps={[]} state="loading" />
          </Card>
          <Card title="Empty">
            <Timeline steps={[]} state="empty" />
          </Card>
        </div>
        <div className="flex flex-wrap gap-6">
          <Countdown expiresAt={Date.now() + 10 * 60_000} />
          <Countdown expiresAt={Date.now() + 90_000} />
          <Countdown expiresAt={NOW - 1} />
        </div>
      </Section>

      <Section title="QR panel">
        <div className="grid gap-4 md:grid-cols-3">
          <QrPanel address={ADDR} amount="25.00 USDC" chain="base" />
          <QrPanel address={ADDR} amount="25.00 USDC" state="loading" />
          <QrPanel address={ADDR} amount="25.00 USDC" state="error" />
        </div>
      </Section>

      <Section title="Wallets">
        <div className="grid items-start gap-6 md:grid-cols-3">
          <NearWalletView accountId={null} ready error={false} signIn={noop} signOut={noop} />
          <NearWalletView
            accountId={null}
            ready={false}
            error={false}
            signIn={noop}
            signOut={noop}
          />
          <NearWalletView accountId={null} ready={false} error signIn={noop} signOut={noop} />
          <NearWalletView accountId="acme.near" ready error={false} signIn={noop} signOut={noop} />
          <EvmWalletView address={null} available error={false} connect={noop} disconnect={noop} />
          <EvmWalletView
            address={null}
            available={false}
            error={false}
            connect={noop}
            disconnect={noop}
          />
          <EvmWalletView address={null} available error connect={noop} disconnect={noop} />
          <EvmWalletView address={ADDR} available error={false} connect={noop} disconnect={noop} />
        </div>
      </Section>

      <Section title="NEAR accounts and the wallet picker">
        <div className="space-y-3">
          <p className="text-[14px]">
            Named: <AccountId value="acme.openrail.near" />
          </p>
          <p className="text-[14px]">
            Implicit, truncated: <AccountId value={IMPLICIT} />
          </p>
          <p className="text-[14px]">
            Implicit, in full: <AccountId value={IMPLICIT} full />
          </p>
          <Button variant="secondary" onClick={() => setPicker(true)}>
            Open wallet picker
          </Button>
        </div>
      </Section>

      <WalletPicker
        wallets={pickerWallets}
        open={picker}
        onPick={() => setPicker(false)}
        onClose={() => setPicker(false)}
      />

      <Section title="Toast, modal and drawer">
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            onClick={() => toast({ tone: "success", title: "Paid", body: "INV-0001 · $2,500.00" })}
          >
            Show success toast
          </Button>
          <Button variant="secondary" onClick={() => toast({ tone: "info", title: "Link copied" })}>
            Show info toast
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast({
                tone: "error",
                title: "Couldn't copy",
                body: "Select the text and copy it by hand.",
              })
            }
          >
            Show error toast
          </Button>
          <Button onClick={() => setModal(true)}>Open modal</Button>
          <Button variant="secondary" onClick={() => setDrawer(true)}>
            Open drawer
          </Button>
        </div>
      </Section>

      <Modal open={modal} onClose={() => setModal(false)} title="Cancel this invoice?">
        <p>The pay link stops working. Money already paid stays in your account.</p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setModal(false)}>
            Keep invoice
          </Button>
          <Button variant="danger" onClick={() => setModal(false)}>
            Cancel invoice
          </Button>
        </div>
      </Modal>
      <Modal
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Invoice details"
        variant="drawer"
      >
        <p>Details open in a drawer on the right.</p>
      </Modal>
    </main>
  );
}
