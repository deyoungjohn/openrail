// The claim as the UI sees it. Field names follow blueprint 2.1; the UI word is "invoice".

export type Debtor = { kind: "near"; account: string } | { kind: "evm"; address: `0x${string}` };

export type Ack =
  | { scheme: "near"; account: string; block: number }
  | { scheme: "evm"; chainId: number; signer: `0x${string}`; block: number };

export type ClaimStatus = "Issued" | "PartiallyPaid" | "Paid" | "Cancelled" | "Closed";

export type Lock =
  | { kind: "None" }
  | { kind: "Reconciling"; since: number }
  | { kind: "TransferWindow"; until: number }
  | { kind: "Module"; id: string; until: number };

export interface Claim {
  tokenId: string;
  invoiceNumber: string;
  ownerId: string;
  issuerId: string;
  claimAccount: string;
  /** What the invoice is for, when the API has it. */
  lineItems?: { description: string; quantity: number; unit_amount_usd: string }[];
  rootContract: string;
  debtor: Debtor | null;
  debtorName: string;
  issuerName: string;
  /** 0x-prefixed sha256 of the canonical terms JSON. */
  termsHash: `0x${string}`;
  /** USDC base units, 6 decimals. */
  amountDue: bigint;
  /** Unix seconds. */
  dueDate: number;
  ack: Ack | null;
  status: ClaimStatus;
  lock: Lock;
  bookedTotal: bigint;
  surplus: bigint;
  creditTotal: bigint;
}

export type PaymentLogEntry =
  | {
      kind: "Quote";
      quoteId: string;
      depositAddress: string;
      /** Unix seconds. */
      deadline: number;
      refundTo: string;
      routeId: string;
    }
  | { kind: "Other" };

/** Blueprint 2.3: amount_due - (booked_total - surplus) - credit_total. */
export const outstanding = (c: Claim): bigint =>
  c.amountDue - (c.bookedTotal - c.surplus) - c.creditTotal;

/** Base units to cents. USDC has 6 decimals, USD has 2; the part below a cent is shown by callers that need it. */
export const usdcToCents = (units: bigint): bigint => units / 10_000n;

export const isOverdue = (c: Claim, nowSec: number): boolean =>
  nowSec > c.dueDate && (c.status === "Issued" || c.status === "PartiallyPaid");
