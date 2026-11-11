import type { Ack, Claim, ClaimStatus, Lock, PaymentLogEntry } from "./claim";
import { client } from "./client";
import type { OpenrailApi } from "./api";

/**
 * The claim and ack screens read the chain directly and the invoice names from the API. The contract's
 * `claim` and `payment_log` views are public and answer without a key, so a visitor who only holds the
 * link needs nothing but the page. (The API's public `GET /v1/ack/{token}` adds the names and the terms.)
 */
const RPC_URLS = (process.env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://free.rpc.fastnear.com")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
const ROOT = process.env.NEXT_PUBLIC_ROOT_CONTRACT ?? "openrail.near";

/** The JSON of the contract's `ClaimView` (only what the screens read). */
export interface ClaimViewJson {
  token_id: string;
  issuer_id: string;
  owner_id: string;
  claim_account: string;
  debtor: { Evm: string } | { Near: string } | null;
  terms_hash: string;
  amount_due: string;
  due_date: number;
  ack: {
    scheme: { Evm: { chain_id: number; signer: string } } | { Near: { account: string } };
    block: number;
  } | null;
  status: ClaimStatus;
  lock:
    | "None"
    | { Reconciling: { since: number } }
    | { TransferWindow: { until: number } }
    | { Module: { id: string; until: number } };
  booked_total: string;
  surplus: string;
  credit_total: string;
}

export interface QuoteJson {
  quote_id: string;
  deposit_address: string;
  deadline_requested: number;
  refund_to: string;
  route_id: string;
}

function lockOf(lock: ClaimViewJson["lock"]): Lock {
  if (lock === "None") return { kind: "None" };
  if ("Reconciling" in lock) return { kind: "Reconciling", since: lock.Reconciling.since };
  if ("TransferWindow" in lock) return { kind: "TransferWindow", until: lock.TransferWindow.until };
  return { kind: "Module", id: lock.Module.id, until: lock.Module.until };
}

function ackOf(ack: ClaimViewJson["ack"]): Ack | null {
  if (ack === null) return null;
  if ("Evm" in ack.scheme) {
    return {
      scheme: "evm",
      chainId: ack.scheme.Evm.chain_id,
      signer: ack.scheme.Evm.signer as `0x${string}`,
      block: ack.block,
    };
  }
  return { scheme: "near", account: ack.scheme.Near.account, block: ack.block };
}

/** Pure: the contract's view plus the invoice's names become the screens' `Claim`. */
export function claimFromView(
  v: ClaimViewJson,
  names: {
    invoiceNumber?: string;
    issuerName?: string;
    debtorName?: string;
    lineItems?: Claim["lineItems"];
  } = {},
  rootContract: string = ROOT,
): Claim {
  const debtor =
    v.debtor === null
      ? null
      : "Evm" in v.debtor
        ? ({ kind: "evm", address: v.debtor.Evm as `0x${string}` } as const)
        : ({ kind: "near", account: v.debtor.Near } as const);
  return {
    tokenId: v.token_id,
    invoiceNumber: names.invoiceNumber ?? v.token_id,
    ownerId: v.owner_id,
    issuerId: v.issuer_id,
    claimAccount: v.claim_account,
    ...(names.lineItems && names.lineItems.length > 0 ? { lineItems: names.lineItems } : {}),
    rootContract,
    debtor,
    debtorName: names.debtorName ?? "",
    issuerName: names.issuerName ?? v.issuer_id,
    termsHash: v.terms_hash as `0x${string}`,
    amountDue: BigInt(v.amount_due),
    dueDate: v.due_date,
    ack: ackOf(v.ack),
    status: v.status,
    lock: lockOf(v.lock),
    bookedTotal: BigInt(v.booked_total),
    surplus: BigInt(v.surplus),
    creditTotal: BigInt(v.credit_total),
  };
}

export function paymentLogFromQuotes(quotes: QuoteJson[]): PaymentLogEntry[] {
  return quotes.map((q) => ({
    kind: "Quote" as const,
    quoteId: q.quote_id,
    depositAddress: q.deposit_address,
    deadline: q.deadline_requested,
    refundTo: q.refund_to,
    routeId: q.route_id,
  }));
}

async function view<T>(method: string, args: object): Promise<T> {
  let last: unknown = new Error("RPC: no url");
  for (const url of RPC_URLS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: ROOT,
            method_name: method,
            args_base64: btoa(JSON.stringify(args)),
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as { result?: { result?: number[] }; error?: unknown };
      if (!body.result?.result) throw new Error("VIEW_FAILED");
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result))) as T;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

export const liveApi: OpenrailApi = {
  async getClaim(tokenId) {
    const v = await view<ClaimViewJson | null>("claim", { token_id: tokenId });
    if (v === null) return null;
    // Names and the invoice number come from the API; the page still works without them.
    const doc = await client.ack.get(tokenId).catch(() => null);
    const terms = doc?.terms as
      { issuer_legal_name?: string; debtor_legal_name?: string } | undefined;
    return claimFromView(v, {
      invoiceNumber: doc?.invoice_number,
      issuerName: terms?.issuer_legal_name,
      debtorName: terms?.debtor_legal_name,
      lineItems: (doc as { line_items?: Claim["lineItems"] } | null)?.line_items,
    });
  },
  async getPaymentLog(tokenId) {
    return paymentLogFromQuotes(
      await view<QuoteJson[]>("payment_log", { token_id: tokenId, from: 0, limit: 50 }),
    );
  },
  async relayEvmAck(tokenId, chainId, signature) {
    await client.ack.evm(tokenId, { chain_id: chainId, signature });
  },
};
