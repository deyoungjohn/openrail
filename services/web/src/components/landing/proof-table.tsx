"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Pagination } from "@/components/ui/pagination";
import { nearAccountUrl, nearTxUrl, type ProofRow } from "@/lib/proof-data";

const PAGE = 20;

const when = (t: number) =>
  `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(t * 1000))} UTC`;

/** The Proof page's transactions, 20 to a page, newest first. */
export function ProofTable({ rows }: { rows: readonly ProofRow[] }) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const [page, setPage] = useState(1);
  const from = (page - 1) * PAGE;
  const shown = rows.slice(from, from + PAGE);
  return (
    <>
      <div className="mt-8 overflow-x-auto rounded-[22px] border border-border bg-surface">
        <table className="w-full min-w-[860px] text-left text-[14px]">
          <caption className="sr-only">Openrail transactions on NEAR mainnet, newest first</caption>
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
            {shown.map((r, i) => (
              <tr key={r.tx} className="border-b border-border last:border-0">
                <td className="tabular px-4 py-3 text-muted">{from + i + 1}</td>
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
      {pages > 1 ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="caption" aria-live="polite">
            {from + 1}–{Math.min(from + PAGE, rows.length)} of {rows.length}
          </p>
          <Pagination
            totalPages={pages}
            page={page}
            onPageChange={setPage}
            aria-label="Proof pages"
          />
        </div>
      ) : null}
    </>
  );
}
