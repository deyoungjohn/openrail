/**
 * The app's screens drawn in HTML for the Features page, from the page's own tokens (light and dark). Sample figures:
 * the real, smaller payments are on the Proof page.
 */
import {
  CheckCircle2,
  ChevronDown,
  Download,
  FileText,
  Lock,
  Plus,
  Search,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { ChainIcon, CoinIcon, type ChainId } from "@/components/ui/chain-badge";
import { cn } from "@/lib/cn";

function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-full rounded-2xl border border-border bg-surface p-4 text-left text-text",
        className,
      )}
    >
      {title ? (
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-[14px] font-semibold">{title}</p>
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}

const Pill = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-medium text-success-text">
    <CheckCircle2 aria-hidden size={11} /> {children}
  </span>
);

const AccentButton = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11.5px] font-semibold text-on-accent">
    {children}
  </span>
);

function Field({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2 px-3 py-2">
      <p className="text-[10.5px] text-muted">{label}</p>
      <p className="flex items-center gap-2 text-[13px] font-medium">
        {icon}
        {value}
        <ChevronDown aria-hidden size={13} className="ml-auto text-muted" />
      </p>
    </div>
  );
}

function Slider({ at }: { at: number }) {
  return (
    <div className="px-1 pt-2 pb-5">
      <div className="relative h-1.5 rounded-full bg-border">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${at}%` }}
        />
        <span
          className="absolute top-1/2 size-4 -translate-1/2 rounded-full border-2 border-accent bg-surface"
          style={{ left: `${at}%` }}
        />
        {[25, 50, 75, 100].map((m) => (
          <span
            key={m}
            className="absolute top-3 -translate-x-1/2 text-[9.5px] text-muted"
            style={{ left: `${m}%` }}
          >
            {m}%
          </span>
        ))}
      </div>
    </div>
  );
}

function InvoicesMock() {
  const rows: [string, string, string][] = [
    ["INV-1042", "Northwind Ltd", "$1,240.00"],
    ["INV-1041", "Spectra Inc", "$386.50"],
    ["INV-1040", "Alex Beck", "$96.00"],
    ["INV-1039", "Malcolm Armas", "$48.50"],
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        {[
          ["Collected", "$4,820"],
          ["Outstanding", "$1,240"],
          ["Invoices", "38"],
        ].map(([k, v]) => (
          <Panel key={k} className="p-3">
            <p className="text-[11px] text-muted">{k}</p>
            <p className="tabular mt-0.5 text-[16px] font-bold sm:text-[22px]">{v}</p>
          </Panel>
        ))}
      </div>
      <Panel
        title="Invoices"
        action={
          <AccentButton>
            <Plus aria-hidden size={12} /> Create invoice
          </AccentButton>
        }
      >
        <p className="mb-2 flex w-36 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted">
          <Search aria-hidden size={11} /> Search
        </p>
        {rows.map(([n, c, a]) => (
          <div
            key={n}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-t sm:grid-cols-[1fr_1.3fr_auto_auto] sm:gap-3 border-border py-2 text-[12px]"
          >
            <span className="font-mono text-accent-text">{n}</span>
            <span className="truncate">{c}</span>
            <span className="hidden sm:inline-flex">
              <Pill>Paid</Pill>
            </span>
            <span className="tabular text-right font-medium sm:w-[72px]">{a}</span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function CheckoutMock() {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_1.1fr]">
      <Panel title="Order #2291">
        <p className="text-[11.5px] text-muted">Belmonte Apparels</p>
        <p className="tabular mt-1 text-[30px] leading-9 font-bold">$128.40</p>
        <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-[12px]">
          <p className="flex justify-between">
            <span>Linen shirt × 2</span>
            <span className="tabular">$98.40</span>
          </p>
          <p className="flex justify-between">
            <span>Shipping</span>
            <span className="tabular">$30.00</span>
          </p>
        </div>
      </Panel>
      <Panel>
        <div className="mb-3 flex rounded-full bg-surface-2 p-1 text-[11.5px] font-medium">
          <span className="flex-1 rounded-full bg-surface py-1 text-center">Wallet</span>
          <span className="flex-1 py-1 text-center text-muted">Exchange</span>
          <span className="flex-1 py-1 text-center text-muted">Split</span>
        </div>
        <div className="space-y-2">
          <Field label="Pay with" value="USDC" icon={<CoinIcon asset="USDC" size={16} />} />
          <Field label="Network" value="Base" icon={<ChainIcon chain="base" size={16} />} />
        </div>
        <p className="mt-3 rounded-full bg-accent py-2 text-center text-[12.5px] font-semibold text-on-accent">
          Pay $128.40 USDC
        </p>
      </Panel>
    </div>
  );
}

function DashboardMock() {
  const bars = [38, 52, 44, 70, 58, 86, 64];
  const pie: [ChainId, number][] = [
    ["base", 34],
    ["solana", 26],
    ["near", 22],
    ["arbitrum", 18],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Panel title="Monthly revenue" className="sm:col-span-2">
        <p className="tabular text-[26px] font-bold">
          $4,820.30 <span className="text-[12px] font-medium text-success-text">+18%</span>
        </p>
        <svg viewBox="0 0 300 70" className="mt-2 h-16 w-full" aria-hidden>
          <path
            d="M0 60 L40 52 L80 56 L120 40 L160 44 L200 26 L240 30 L300 8"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.5"
          />
        </svg>
      </Panel>
      <Panel title="Weekly activity">
        <div className="flex h-20 items-end gap-2">
          {bars.map((h, i) => (
            <span
              key={i}
              className={cn("flex-1 rounded-t-md", i === 5 ? "bg-accent" : "bg-accent/30")}
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </Panel>
      <Panel title="Where clients paid from">
        {pie.map(([c, p]) => (
          <div key={c} className="mb-1.5 flex items-center gap-2 text-[11.5px]">
            <ChainIcon chain={c} size={16} />
            <span className="h-1.5 flex-1 rounded-full bg-border">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${p * 2.5}%` }}
              />
            </span>
            <span className="tabular w-8 text-right">{p}%</span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function ReceiptMock() {
  return (
    <Panel className="mx-auto max-w-[420px] p-5">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-muted">Receipt · INV-1042</p>
        <Pill>Paid</Pill>
      </div>
      <p className="tabular mt-2 text-[30px] leading-9 font-bold">$1,240.00</p>
      <p className="text-[11.5px] text-muted">Paid Nov 12, 2026 · from Base · USDC</p>
      <div className="mt-4 space-y-1.5 border-t border-border pt-3 text-[12px]">
        {[
          ["Brand design, 2 weeks", "$1,100.00"],
          ["Revisions", "$140.00"],
        ].map(([l, a]) => (
          <p key={l} className="flex justify-between">
            <span>{l}</span>
            <span className="tabular">{a}</span>
          </p>
        ))}
      </div>
      <div className="mt-4 space-y-1.5 rounded-xl bg-surface-2 p-3 text-[11px]">
        <p className="flex justify-between">
          <span className="text-muted">Payment</span>
          <span className="font-mono text-accent-text">0x8f3a…c21e ↗</span>
        </p>
        <p className="flex justify-between">
          <span className="text-muted">Booked on NEAR</span>
          <span className="font-mono text-accent-text">4wFEBE…3q5T ↗</span>
        </p>
        <p className="flex justify-between">
          <span className="text-muted">Terms fingerprint</span>
          <span className="font-mono">b38f…a7dd</span>
        </p>
      </div>
      <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11.5px] font-medium">
        <Download aria-hidden size={12} /> Download PDF
      </p>
    </Panel>
  );
}

function StatementMock() {
  const rows: [string, string, string][] = [
    ["Nov 9", "INV-1039", "$48.50"],
    ["Nov 9", "Checkout #2288", "$74.50"],
    ["Nov 11", "Checkout shopify-6581", "$112.00"],
    ["Nov 11", "INV-1040", "$96.00"],
    ["Nov 12", "INV-1042", "$1,240.00"],
  ];
  return (
    <div className="space-y-3">
      <Panel>
        <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-success-text">
          <ShieldCheck aria-hidden size={14} /> Fingerprint matches the file.
        </p>
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11.5px] font-medium">
          <Download aria-hidden size={12} /> statement-2026-11-01-2026-11-13.pdf
        </p>
      </Panel>
      <div className="relative overflow-hidden rounded-2xl border border-border bg-white p-5 text-[#0f172a]">
        <span
          aria-hidden
          className="absolute -top-6 -left-6 size-24 rotate-45 bg-[#3f46fe]"
          style={{ clipPath: "polygon(0 0,100% 0,0 100%)" }}
        />
        <p className="text-center text-[13px] font-semibold">Belmonte Apparels</p>
        <p className="text-center text-[22px] font-extrabold">
          Settled <span className="text-[#3f46fe]">Payments</span>
        </p>
        <p className="text-center text-[10.5px] text-[#5b6b82]">Statement, Nov 1 to Nov 13, 2026</p>
        <p className="mt-3 bg-[#3f46fe] py-1 text-center text-[10.5px] font-bold text-white">
          PAYMENTS
        </p>
        {rows.map(([d, f, a], i) => (
          <p
            key={i}
            className="grid grid-cols-[24px_52px_1fr_auto] border-b border-[#e4e7ee] py-1 text-[10.5px]"
          >
            <span>{i + 1}</span>
            <span>{d}</span>
            <span className="truncate">{f}</span>
            <span className="tabular">{a}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function ConfidentialMock() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        {[
          ["Held", "$0.00"],
          ["On its way", "$0.00"],
          ["Confidential", "$1,486.80"],
        ].map(([k, v]) => (
          <Panel key={k} className="p-3">
            <p className="text-[11px] text-muted">{k}</p>
            <p
              className={cn(
                "tabular mt-0.5 text-[12.5px] font-bold sm:text-[18px]",
                k === "Confidential" && "text-accent-text",
              )}
            >
              {v}
            </p>
          </Panel>
        ))}
      </div>
      <Panel
        title="Withdraw from your confidential balance"
        action={<Lock aria-hidden size={14} className="text-muted" />}
      >
        <div className="space-y-2">
          <Field
            label="Take it from"
            value="SOL USDC · $1,486.80"
            icon={<ChainIcon chain="solana" size={16} />}
          />
          <p className="pt-1 text-[12px]">
            Available to withdraw now: <b className="tabular">$1,486.80</b>{" "}
            <span className="text-muted">SOL USDC</span>
          </p>
          <div className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-[13px] font-medium tabular">
            743.40
          </div>
          <Slider at={50} />
          <Field label="Network" value="Arbitrum" icon={<ChainIcon chain="arbitrum" size={16} />} />
        </div>
      </Panel>
    </div>
  );
}

function CashOutMock() {
  return (
    <Panel>
      <div className="mb-3 flex rounded-full bg-surface-2 p-1 text-[11.5px] font-medium">
        <span className="flex-1 rounded-full bg-surface py-1 text-center">Public</span>
        <span className="flex-1 py-1 text-center text-muted">Confidential</span>
      </div>
      <div className="space-y-2">
        <Field
          label="Take it from"
          value="BASE USDC · $648.38"
          icon={<ChainIcon chain="base" size={16} />}
        />
        <p className="pt-1 text-[12px]">
          Available to cash out now: <b className="tabular">$648.38</b>{" "}
          <span className="text-muted">BASE USDC</span>
        </p>
        <div className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-[13px] font-medium tabular">
          486.29
        </div>
        <Slider at={75} />
        <Field label="Send to" value="NEAR" icon={<ChainIcon chain="near" size={16} />} />
        <p className="mx-auto mt-2 w-fit rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-on-accent">
          Get quote
        </p>
      </div>
    </Panel>
  );
}

function ScheduleMock() {
  return (
    <div className="space-y-3">
      <Panel title="Confidential balance">
        <p className="text-[12px] text-muted">
          On. Payments of $1 or more are held, then moved into your confidential balance on your
          schedule.
        </p>
        <p className="mt-3 w-fit rounded-lg border border-border px-3 py-1.5 text-[11.5px] font-medium">
          Turn off
        </p>
      </Panel>
      <Panel title="Payout schedule">
        <Field label="When held payments are sent" value="Once a week" />
        <div className="mt-2 grid grid-cols-4 gap-1.5 text-center text-[10.5px]">
          {["Each payment", "Daily", "Weekly", "Monthly"].map((x) => (
            <span
              key={x}
              className={cn(
                "rounded-lg border px-1 py-1.5",
                x === "Weekly"
                  ? "border-accent bg-accent/10 font-semibold text-accent-text"
                  : "border-border text-muted",
              )}
            >
              {x}
            </span>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function ApiMock() {
  return (
    <Panel
      title="Webhook endpoints"
      action={
        <AccentButton>
          <Plus aria-hidden size={12} /> Add endpoint
        </AccentButton>
      }
    >
      {["https://shop.example.com/openrail/webhook", "https://api.example.com/hooks/openrail"].map(
        (u) => (
          <div key={u} className="border-t border-border py-3">
            <p className="truncate font-mono text-[11.5px]">{u}</p>
            <p className="mt-1 text-[10.5px] text-muted">
              invoice.paid, invoice.partially_paid, payment.late, checkout.paid
            </p>
            <div className="mt-2 flex gap-1.5 text-[10.5px] font-medium">
              {["Send test event", "Delivery log", "Delete"].map((b) => (
                <span key={b} className="rounded-lg border border-border px-2 py-1">
                  {b}
                </span>
              ))}
            </div>
          </div>
        ),
      )}
      <pre className="mt-1 overflow-hidden rounded-xl bg-surface-2 p-3 font-mono text-[10.5px] leading-4 text-muted">{`POST /v1/invoices
Authorization: Bearer sk_live_…
{ "amount_usd": "240.00", "client": "Northwind" }`}</pre>
    </Panel>
  );
}

function StoresMock() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[
        ["Shopify", "Openrail app installed", "#95bf47"],
        ["WooCommerce", "Plugin 0.1.4 active", "#7f54b3"],
      ].map(([n, s, c]) => (
        <Panel key={n} className="p-3">
          <p className="flex items-center gap-2 text-[13px] font-semibold">
            <span className="size-3 rounded-full" style={{ background: c }} /> {n}
          </p>
          <p className="mt-1 text-[11.5px] text-muted">{s}</p>
        </Panel>
      ))}
      <Panel className="sm:col-span-2" title="Checkout">
        <p className="text-[12px] text-muted">Pay with</p>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
          <span className="rounded-xl border border-border px-3 py-2">Card</span>
          <span className="flex items-center gap-2 rounded-xl border-2 border-accent px-3 py-2 font-semibold">
            <CoinIcon asset="USDC" size={16} /> Stablecoins
            <span className="ml-auto flex -space-x-1">
              {(["near", "base", "solana"] as const).map((c) => (
                <span key={c} className="rounded-full ring-2 ring-surface">
                  <ChainIcon chain={c} size={14} />
                </span>
              ))}
            </span>
          </span>
        </div>
      </Panel>
    </div>
  );
}

function AgentsMock() {
  return (
    <Panel className="font-mono text-[11.5px]">
      <p className="text-muted">you › bill Northwind $250 for the December retainer</p>
      <p className="mt-3 text-muted">agent → openrail.prepare_invoice</p>
      <pre className="mt-1 rounded-xl bg-surface-2 p-3 whitespace-pre-wrap">{`{ "debtor": "northwind.near",
  "amountDue": "250000000",
  "dueDate": 1796083200 }`}</pre>
      <p className="mt-3 flex items-center gap-1.5 font-sans text-[12px] text-success-text">
        <CheckCircle2 aria-hidden size={14} /> Ready to sign: approval link sent to you
      </p>
      <p className="mt-3 text-muted">agent → openrail.list_claims {'{ "status": "Paid" }'}</p>
      <p className="mt-1 flex items-center gap-1.5 font-sans text-[12px]">
        <FileText aria-hidden size={13} /> 3 paid this week, $1,486.80
      </p>
    </Panel>
  );
}

export const FEATURE_MOCKS: Record<string, () => ReactNode> = {
  invoices: InvoicesMock,
  checkout: CheckoutMock,
  dashboards: DashboardMock,
  receipts: ReceiptMock,
  statements: StatementMock,
  confidential: ConfidentialMock,
  "cash-out": CashOutMock,
  schedule: ScheduleMock,
  api: ApiMock,
  stores: StoresMock,
  agents: AgentsMock,
};
