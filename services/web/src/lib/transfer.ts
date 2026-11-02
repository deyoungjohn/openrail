import { copy } from "../copy";
import type { Claim, PaymentLogEntry } from "./claim";

export interface TransferInput {
  receiver: string;
  /** 64 hex characters, from the signed assignment document. */
  assignmentDocHash: string;
}

/** `kind_rules` of the claim's kind (blueprint 2.4). Core kind: both true. */
export interface KindRules {
  ackRequiredForSale: boolean;
  sellable: boolean;
}

export interface Refusal {
  /** Blueprint 2.4 rule number; 0 is a form check that is not a contract rule. */
  rule: number;
  message: string;
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

const refuse = (rule: number, text: string): Refusal => ({
  rule,
  message: rule === 0 ? text : `Rule ${rule}: ${text}`,
});

/**
 * Pre-checks rules 1 to 5 and 7 of blueprint 2.4 so the seller sees a refusal before signing.
 * Rule 6 (exactly 1 yoctoNEAR) holds by construction; rule 8 (module hooks) is decided by the
 * contract, whose panic message is shown as it comes.
 */
export function checkTransfer(claim: Claim, input: TransferInput, rules: KindRules): Refusal[] {
  const out: Refusal[] = [];
  const text = copy.transfer.rules;
  const sale = input.receiver !== claim.issuerId;

  if (claim.lock.kind === "Reconciling" || claim.lock.kind === "Module")
    out.push(refuse(1, text[1]));
  if (claim.status !== "Issued" && claim.status !== "PartiallyPaid") out.push(refuse(2, text[2]));
  if (sale && rules.ackRequiredForSale && claim.ack === null) out.push(refuse(3, text[3]));
  if (sale && !HEX64.test(input.assignmentDocHash)) out.push(refuse(4, text[4]));
  if (input.receiver === claim.claimAccount) out.push(refuse(5, text[5]));
  if (!rules.sellable) out.push(refuse(7, text[7]));

  if (!NEAR_ACCOUNT.test(input.receiver)) out.push(refuse(0, text.badAccount));
  return out;
}

export type QuoteEntry = Extract<PaymentLogEntry, { kind: "Quote" }>;

/** Pay-link quotes still inside their deadline, soonest first (the cut-off list, blueprint 2.4). */
export function openQuotes(log: readonly PaymentLogEntry[], nowSec: number): QuoteEntry[] {
  return log
    .filter((e): e is QuoteEntry => e.kind === "Quote" && e.deadline > nowSec)
    .sort((a, b) => a.deadline - b.deadline);
}

/** sha256 as 64 lowercase hex characters. Only the hash leaves the browser, never the file. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
