import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { CountUp } from "@/components/landing/count-up";
import type { ProofRow } from "@/lib/proof-data";
import { proofStats } from "@/lib/proof-stats";

/**
 * Openrail's numbers on NEAR mainnet, added up from the same live data as the Proof page (the demo business's
 * transactions), so they move as new payments are booked. Each number counts up when it scrolls into view.
 */
export function Stats({ proof }: { proof: readonly ProofRow[] }) {
  const s = proofStats(proof);
  const cells: {
    label: string;
    to: number;
    decimals?: number;
    prefix?: string;
    suffix?: string;
  }[] = [
    { label: "Processed onchain, USD", to: s.processedUsd, decimals: 2, prefix: "$" },
    { label: "Payments booked", to: s.payments },
    { label: "Invoices and checkouts", to: s.requests },
    { label: "Average payment, USD", to: s.averageUsd, decimals: 2, prefix: "$" },
    { label: "Chains to pay from", to: 8 },
    { label: "Median time to booking", to: 30.5, decimals: 1, suffix: " s" },
  ];
  return (
    <section id="stats" className="py-24">
      <div className="mx-auto max-w-[1240px] px-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-[clamp(36px,5.5vw,64px)] leading-[1.02] font-extrabold tracking-[-0.03em]">
            Real Money,
            <br />
            <span className="text-muted">Booked On NEAR.</span>
          </h2>
          <Link
            href="/proof"
            className="inline-flex items-center gap-1.5 text-[15px] font-medium text-accent-text hover:underline"
          >
            Every transaction <ArrowRight aria-hidden size={16} />
          </Link>
        </div>
        <dl className="mt-12 grid grid-cols-1 gap-px border-y border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {cells.map((c) => (
            <div key={c.label} className="flex flex-col-reverse bg-bg py-8 sm:px-6">
              <dt className="mt-4 font-mono text-[13px] tracking-[0.08em] text-muted uppercase">
                {c.label}
              </dt>
              <dd className="tabular text-[clamp(40px,5vw,60px)] leading-none font-bold tracking-[-0.02em]">
                <CountUp
                  to={c.to}
                  decimals={c.decimals ?? 0}
                  prefix={c.prefix ?? ""}
                  suffix={c.suffix ?? ""}
                />
              </dd>
            </div>
          ))}
        </dl>
        <p className="caption mt-6">
          Live from NEAR mainnet: the demo business&apos;s bookings by <code>openrail.near</code>,
          updated every minute. The booking time is the median of timed mainnet checkouts.
        </p>
      </div>
    </section>
  );
}
