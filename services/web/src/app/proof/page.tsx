import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import { CountUp } from "@/components/landing/count-up";
import { LandingNav } from "@/components/landing/nav";
import { LandingFooter } from "@/components/landing/sections";
import { loadProofRows, nearAccountUrl, nearTxUrl, PROOF_CONTRACT } from "@/lib/proof-data";

// Read again from the API at most once a minute: new transactions appear without a deploy.
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Proof: Openrail transactions on NEAR",
  description:
    "Business transactions made by Openrail on NEAR mainnet, each with its explorer link. Machine-readable at /proof.json.",
};

const when = (t: number) =>
  `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(t * 1000))} UTC`;

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
        <div className="mt-8 overflow-x-auto rounded-[22px] border border-border bg-surface">
          <table className="w-full min-w-[860px] text-left text-[14px]">
            <caption className="sr-only">
              Openrail transactions on NEAR mainnet, newest first
            </caption>
            <thead>
              <tr className="border-b border-border text-[13px] text-muted">
                <th scope="col" className="px-4 py-3 font-medium">
                  #
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Transaction
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Time
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Claim account
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Explorer
                </th>
              </tr>
            </thead>
            <tbody>
              {PROOF_ROWS.map((r, i) => (
                <tr key={r.tx} className="border-b border-border last:border-0">
                  <td className="tabular px-4 py-3 text-muted">{i + 1}</td>
                  <td className="px-4 py-3 font-medium">{r.type}</td>
                  <td className="tabular px-4 py-3 text-right font-semibold">${r.amount_usd}</td>
                  <td className="tabular px-4 py-3 whitespace-nowrap text-muted">{when(r.time)}</td>
                  <td className="px-4 py-3">
                    <a
                      href={nearAccountUrl(r.claim)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[12.5px] hover:text-accent-text"
                    >
                      {r.claim.length > 34 ? `${r.claim.slice(0, 30)}…` : r.claim}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={nearTxUrl(r.tx)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`View ${r.type} transaction ${r.tx} on NearBlocks`}
                      className="inline-flex items-center gap-1.5 font-medium text-accent-text hover:underline"
                    >
                      View on NearBlocks <ExternalLink aria-hidden size={13} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
