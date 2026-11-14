import { loadProofRows, nearTxUrl, PROOF_CONTRACT } from "@/lib/proof-data";

// Read again from the API at most once a minute, like the page.
export const revalidate = 60;

/** The Proof page as data, for programs and AI agents. */
export async function GET() {
  const { rows: PROOF_ROWS } = await loadProofRows();
  return Response.json({
    contract: PROOF_CONTRACT,
    network: "near-mainnet",
    note: "Business transactions of the Openrail contract, newest first. Confidential-balance deposits and withdrawals are not listed.",
    transactions: PROOF_ROWS.map((r) => ({
      type: r.type,
      amount_usd: r.amount_usd,
      time: new Date(r.time * 1000).toISOString(),
      claim_account: r.claim,
      tx_hash: r.tx,
      explorer_url: nearTxUrl(r.tx),
    })),
  });
}
