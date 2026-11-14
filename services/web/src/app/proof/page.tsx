import type { Metadata } from "next";
import { CountUp } from "@/components/landing/count-up";
import { LandingNav } from "@/components/landing/nav";
import { ProofTable } from "@/components/landing/proof-table";
import { LandingFooter } from "@/components/landing/sections";
import { loadProofRows, nearAccountUrl, PROOF_CONTRACT } from "@/lib/proof-data";

// Read again from the API at most once a minute: new transactions appear without a deploy.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Proof: Openrail transactions on NEAR",
  description:
    "Business transactions made by Openrail on NEAR mainnet, each with its explorer link. Machine-readable at /proof.json.",
};

export default async function ProofPage() {
  const { rows: PROOF_ROWS } = await loadProofRows();
  const paid = PROOF_ROWS.filter(
    (r) => r.type === "Checkout paid" || r.type === "Invoice payment booked",
  );
  const total = paid.reduce((n, r) => n + Math.round(Number(r.amount_usd) * 100), 0);
  return (
    <div className="min-h-dvh bg-bg text-text">
      <LandingNav />
      <main className="mx-auto max-w-[1240px] px-4 pt-10 pb-24 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[14px] font-semibold text-accent-text">Proof</p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft px-3 py-1 text-[12.5px] font-semibold text-accent-text">
            Demo business · Belmonte Apparels
          </span>
        </div>
        <h1 className="mt-2 text-[clamp(36px,6vw,72px)] leading-[1] font-extrabold tracking-[-0.03em]">
          Every Payment, Onchain
        </h1>
        <p className="mt-5 max-w-[64ch] text-[16px] leading-7 text-muted">
          Only the transactions of{" "}
          <strong className="font-semibold text-text">Belmonte Apparels</strong>, the
          developer&apos;s own hypothetical business, run to prove the technology works with real
          money. These are its {PROOF_ROWS.length} most recent transactions through the Openrail
          contract,{" "}
          <a
            href={nearAccountUrl(PROOF_CONTRACT)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-accent-text hover:underline"
          >
            {PROOF_CONTRACT}
          </a>
          , on NEAR mainnet: invoices and checkouts issued, payments booked, late payments refunded.
          Each row links to the explorer, so anyone can check it. Confidential-balance deposits and
          withdrawals are not listed. The same list is at{" "}
          <a href="/proof.json" className="font-mono text-accent-text hover:underline">
            /proof.json
          </a>{" "}
          for programs and AI agents.
        </p>
        <dl className="mt-8 grid max-w-[640px] grid-cols-3 gap-3">
          {(
            [
              ["Transactions", PROOF_ROWS.length, 0, ""],
              ["Payments booked", paid.length, 0, ""],
              ["Paid in", total / 100, 2, "$"],
            ] as const
          ).map(([k, v, d, pre]) => (
            <div key={k} className="rounded-2xl border border-border bg-surface p-4">
              <dt className="text-[13px] text-muted">{k}</dt>
              <dd className="mt-1 text-[40px] leading-[1.1] font-bold">
                <CountUp to={v} decimals={d} prefix={pre} />
              </dd>
            </div>
          ))}
        </dl>
        <ProofTable rows={PROOF_ROWS} />
      </main>
      <LandingFooter />
    </div>
  );
}
