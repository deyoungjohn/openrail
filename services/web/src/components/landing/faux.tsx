/**
 * Product pictures for the landing page, drawn in HTML from the app's own pieces and the real figures of the Proof
 * page. No chart library and no network: the page stays light.
 */
import { CheckCircle2, ChevronDown, FileText, LayoutGrid, Lock, Plug, Wallet } from "lucide-react";
import { ChainIcon, CHAINS, CoinIcon, type ChainId } from "@/components/ui/chain-badge";
import { cn } from "@/lib/cn";
import { CountUp } from "./count-up";

const usd = (s: string) => `$${s}`;

/** A small payment notice, as the merchant sees it arrive. */
export function Toast({
  title,
  sub,
  amount,
  chain,
  className,
}: {
  title: string;
  sub: string;
  amount: string;
  chain: ChainId;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-[290px] items-center gap-3 rounded-2xl border border-border bg-surface px-3.5 py-3 text-left",
        className,
      )}
    >
      <ChainIcon chain={chain} size={28} />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-semibold">{title}</p>
        <p className="text-[11.5px] text-muted">{sub}</p>
      </div>
      <span className="tabular text-[13px] font-medium text-success-text">{amount}</span>
    </div>
  );
}

/**
 * A sample month of a busy shop, drawn as the dashboard shows it (illustration: the real, smaller payments are on
 * the Proof page and are never inflated there).
 */
const SAMPLE: {
  type: "Checkout paid" | "Invoice payment booked";
  amount_usd: string;
  tx: string;
}[] = [
  { type: "Checkout paid", amount_usd: "128.40", tx: "4wFEBE6KaMvdXU1TwH8SmdC7NGDA3q5T" },
  { type: "Invoice payment booked", amount_usd: "96.00", tx: "5bLrANGUiNQjPzRVscgTrfxRUV9bofifo" },
  { type: "Checkout paid", amount_usd: "74.50", tx: "Eo1rLiwGmD6o4ufiLAPTHbF6vLhCvszX" },
  { type: "Checkout paid", amount_usd: "112.00", tx: "1U5V144RTPyF8aATsAgzHAbg8YeZx23Y" },
  { type: "Invoice payment booked", amount_usd: "49.40", tx: "Fwdo6CjVKRdEP5XNr3FpiRBFuf3QERU1" },
];

/** The dashboard in a browser frame. */
export function FauxDashboard() {
  const paid = SAMPLE;
  const total = paid.reduce((n, r) => n + Math.round(Number(r.amount_usd) * 100), 0);
  const bars = [18, 42, 26, 64, 38, 88, 56];
  const slices: [ChainId, number][] = [
    ["arbitrum", 34],
    ["polygon", 22],
    ["base", 18],
    ["near", 16],
    ["solana", 10],
  ];
  let acc = 0;
  return (
    <div className="overflow-hidden rounded-[22px] border border-border bg-surface">
      <div className="flex h-11 items-center gap-3 border-b border-border px-4">
        <span className="flex gap-1.5" aria-hidden>
          <i className="size-3 rounded-full bg-[#ff5f57]" />
          <i className="size-3 rounded-full bg-[#febc2e]" />
          <i className="size-3 rounded-full bg-[#28c840]" />
        </span>
        <span className="mx-auto flex h-7 w-full max-w-[360px] items-center justify-center gap-1.5 rounded-lg bg-surface-2 text-[12px] text-muted">
          <Lock aria-hidden size={11} /> openrail.incepture.dev/app
        </span>
      </div>
      <div className="flex">
        <aside className="hidden w-[200px] shrink-0 border-r border-border p-4 md:block">
          <p className="mb-4 text-[15px] font-bold tracking-tight">Openrail</p>
          {[
            [LayoutGrid, "Dashboard", true],
            [FileText, "Invoices", false],
            [Wallet, "Cash out", false],
            [Plug, "API Integration", false],
          ].map(([Icon, label, on]) => {
            const I = Icon as typeof LayoutGrid;
            return (
              <p
                key={label as string}
                className={cn(
                  "mb-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]",
                  on ? "bg-accent text-on-accent" : "text-muted",
                )}
              >
                <I aria-hidden size={15} /> {label as string}
              </p>
            );
          })}
        </aside>
        <div className="min-w-0 flex-1 space-y-3 bg-bg p-4">
          <p className="text-[17px] font-semibold">Welcome back, Belmonte Apparels</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-xl border border-border bg-surface p-3">
              <p className="text-[11.5px] text-muted">Revenue this month</p>
              <p className="text-[26px] leading-8 font-bold">
                <CountUp to={total / 100} decimals={2} prefix="$" />
              </p>
              <p className="text-[11px] text-success-text">+ every payment proven on NEAR</p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-3">
              <p className="text-[11.5px] text-muted">Weekly activity</p>
              <div className="mt-1 flex h-[38px] items-end gap-1" aria-hidden>
                {bars.map((h, i) => (
                  <i
                    key={i}
                    className="flex-1 rounded-sm bg-accent/70"
                    style={{ height: `${h}%` }}
                  />
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-surface p-3">
              <p className="text-[11.5px] text-muted">Payments</p>
              <p className="text-[26px] leading-8 font-bold">
                <CountUp to={17} />
              </p>
              <p className="text-[11px] text-muted">invoices and checkouts</p>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
              <svg viewBox="0 0 36 36" className="size-12 -rotate-90" aria-hidden>
                {slices.map(([c, p]) => {
                  const el = (
                    <circle
                      key={c}
                      cx="18"
                      cy="18"
                      r="15.9"
                      fill="none"
                      strokeWidth="5"
                      stroke={CHAIN_COLOR[c]}
                      strokeDasharray={`${p} ${100 - p}`}
                      strokeDashoffset={-acc}
                    />
                  );
                  acc += p;
                  return el;
                })}
              </svg>
              <div>
                <p className="text-[11.5px] text-muted">Clients paid from</p>
                <p className="text-[13px] font-semibold">5 chains</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface">
            <p className="border-b border-border px-3 py-2.5 text-[13px] font-semibold">Inflow</p>
            <table className="w-full text-[12.5px]">
              <tbody>
                {paid.slice(0, 5).map((r) => (
                  <tr key={r.tx} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      {r.type === "Checkout paid" ? "Store customer" : "Client"}
                    </td>
                    <td className="px-3 py-2 text-accent-text">
                      {r.type === "Checkout paid" ? "Checkout" : "Invoice"}
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-[11.5px] text-muted sm:table-cell">
                      {r.tx.slice(0, 10)}…
                    </td>
                    <td className="tabular px-3 py-2 text-right font-medium">
                      {usd(r.amount_usd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export const CHAIN_COLOR: Record<string, string> = {
  base: "#0052ff",
  arbitrum: "#28a0f0",
  ethereum: "#627eea",
  optimism: "#ff0420",
  polygon: "#8247e5",
  bnb: "#f0b90b",
  solana: "#14f195",
  near: "#00c08b",
};

/** An invoice as the client sees it: lines, total, and the chains it can be paid from. */
export function FauxInvoice({ className }: { className?: string }) {
  return (
    <div className={cn("w-[300px] rounded-2xl border border-border bg-surface p-4", className)}>
      <p className="text-[11.5px] text-muted">Invoice #4802461</p>
      <p className="tabular mt-1 text-[28px] leading-8 font-bold">$240.00</p>
      <p className="text-[11.5px] text-muted">Due Nov 20, 2026 · Belmonte Apparels</p>
      <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-[12.5px]">
        <p className="flex justify-between">
          <span>Linen shirt × 4</span>
          <span className="tabular">$180.00</span>
        </p>
        <p className="flex justify-between">
          <span>Delivery</span>
          <span className="tabular">$60.00</span>
        </p>
      </div>
      <p className="mt-3 text-[11.5px] text-muted">Pay from</p>
      <div className="mt-1.5 flex -space-x-1.5">
        {(
          ["near", "base", "arbitrum", "solana", "ethereum", "polygon", "optimism", "bnb"] as const
        ).map((c) => (
          <span key={c} className="rounded-full ring-2 ring-surface">
            <ChainIcon chain={c} size={22} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** The pay panel: token, network, price. */
export function FauxPay({ className }: { className?: string }) {
  return (
    <div className={cn("w-[300px] rounded-2xl border border-border bg-surface p-4", className)}>
      <div className="mb-3 flex rounded-full bg-surface-2 p-1 text-[12.5px] font-medium">
        <span className="flex-1 rounded-full bg-surface py-1.5 text-center">Wallet</span>
        <span className="flex-1 py-1.5 text-center text-muted">Exchange</span>
        <span className="flex-1 py-1.5 text-center text-muted">Split</span>
      </div>
      {[
        ["Pay with", <CoinIcon key="c" asset="USDC" size={18} />, "USDC"],
        ["Network", <ChainIcon key="n" chain="near" size={18} />, "NEAR"],
      ].map(([label, icon, value]) => (
        <div key={label as string} className="mb-2 rounded-xl border border-border px-3 py-2">
          <p className="text-[10.5px] text-muted">{label}</p>
          <p className="flex items-center gap-2 text-[13.5px] font-medium">
            {icon} {value}
            <ChevronDown aria-hidden size={14} className="ml-auto text-muted" />
          </p>
        </div>
      ))}
      <p className="mt-3 rounded-full bg-accent py-2.5 text-center text-[13px] font-semibold text-on-accent">
        Get price
      </p>
    </div>
  );
}

/** Coin cards fanned out like payment cards: the stablecoins a store accepts. */
export function CoinCards({ className }: { className?: string }) {
  const cards: [ChainId, string, string][] = [
    ["near", "USDC", "from-[#00c08b] to-[#3f46fe]"],
    ["base", "USDC", "from-[#0052ff] to-[#7b8bff]"],
    ["solana", "USDT", "from-[#9945ff] to-[#14f195]"],
  ];
  return (
    <div className={cn("relative h-[240px] w-[380px]", className)}>
      {cards.map(([c, coin, g], i) => (
        <div
          key={c}
          className={cn(
            "absolute top-0 h-[200px] w-[150px] rounded-2xl bg-gradient-to-br p-4 text-white",
            g,
          )}
          style={{ left: i * 112, top: i * 12, transform: `rotate(${(i - 1) * 6}deg)` }}
        >
          <span className="inline-block rounded-full bg-white/90 p-0.5">
            <ChainIcon chain={c} size={22} />
          </span>
          <p className="mt-16 text-[26px] leading-none font-extrabold tracking-tight">{coin}</p>
          <p className="mt-1 text-[11px] font-medium opacity-90">on {CHAINS[c]}</p>
        </div>
      ))}
    </div>
  );
}

/** The agent's view: a tool call that issues an invoice. */
export function FauxAgent({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "w-[300px] rounded-2xl border border-border bg-surface p-4 font-mono text-[11.5px]",
        className,
      )}
    >
      <p className="text-muted">agent → openrail.create_invoice</p>
      <pre className="mt-2 whitespace-pre-wrap text-text">{`{ "client": "Northwind",
  "amount_usd": "250.00",
  "due": "2026-12-01" }`}</pre>
      <p className="mt-2 flex items-center gap-1.5 font-sans text-[12px] text-success-text">
        <CheckCircle2 aria-hidden size={14} /> Pay link ready
      </p>
    </div>
  );
}
