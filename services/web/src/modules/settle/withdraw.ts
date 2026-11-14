/** Pure parts of the confidential-balance withdrawal: the exact payload the wallet signs and what is sent back. */
import type { ChainId } from "@/components/ui/chain-badge";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bytes to base58 (Bitcoin alphabet), the encoding NEAR uses for `ed25519:` keys and signatures. */
export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i] as number];
  return out;
}

/** A wallet may answer with a base64 signature; 1Click wants `ed25519:<base58>`. An already prefixed one is kept. */
export function ed25519Signature(signature: string): string {
  if (signature.startsWith("ed25519:")) return signature;
  const raw = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  if (raw.length !== 64) throw new Error("BAD_SIGNATURE_LENGTH");
  return `ed25519:${base58(raw)}`;
}

export interface WithdrawIntent {
  standard: string;
  payload: { message: string; nonce: string; recipient: string };
}

/** The body for `submit-intent`. The payload is passed on exactly as generated; only the signature is added. */
export function signedIntent(
  intent: WithdrawIntent,
  signed: { publicKey: string; signature: string },
) {
  return {
    standard: intent.standard,
    payload: intent.payload,
    public_key: signed.publicKey,
    signature: ed25519Signature(signed.signature),
  };
}

/** The contracts a withdraw intent may be addressed to: the public intents contract and the confidential one. */
const INTENT_CONTRACTS = new Set(["intents.near", "intents.far"]);

/** Every `receiver_id` / `receiver` value anywhere in the signed message (its shape is the provider's). */
export function receiversOf(message: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if ((k === "receiver_id" || k === "receiver") && typeof x === "string") out.push(x);
        else walk(x);
      }
  };
  walk(parsed);
  return out;
}

/**
 * Before the wallet signs: the payload must be a NEP-413 message for an intents contract, signed by this merchant, and
 * every receiver inside it must be the deposit address of the quote just shown. A payload that sends the money anywhere
 * else is refused. The error names the value that failed, so a surprise (the 12 Nov one was a recipient) is readable.
 */
export function checkIntent(
  intent: WithdrawIntent,
  expect?: { depositAddress: string; accountId?: string | null },
): void {
  if (intent.standard !== "nep413")
    throw new Error(`UNEXPECTED_INTENT_STANDARD:${intent.standard}`);
  if (!INTENT_CONTRACTS.has(intent.payload.recipient))
    throw new Error(`UNEXPECTED_INTENT_RECIPIENT:${intent.payload.recipient}`);
  if (expect === undefined) return;
  for (const receiver of receiversOf(intent.payload.message))
    if (receiver.toLowerCase() !== expect.depositAddress.toLowerCase())
      throw new Error(`UNEXPECTED_INTENT_RECEIVER:${receiver.slice(0, 20)}`);
  try {
    const signer = (JSON.parse(intent.payload.message) as { signer_id?: unknown }).signer_id;
    if (typeof signer === "string" && expect.accountId && signer !== expect.accountId)
      throw new Error(`UNEXPECTED_INTENT_SIGNER:${signer.slice(0, 20)}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("UNEXPECTED_")) throw e;
  }
}

/**
 * Which chain's USDC a token in the confidential balance is. The shield moves each payment in as the USDC it settled in,
 * so the balance can hold USDC from several chains; a withdrawal takes from one of them, and only what that one holds.
 * (It used to always take USDC on NEAR: once payments settled on Solana and Base, that one was empty and the provider
 * ended every withdrawal as FAILED.)
 */
export function heldChain(tokenId: string): { label: string; short: string; chain: ChainId } {
  if (tokenId.startsWith("nep141:sol-")) return { label: "Solana", short: "SOL", chain: "solana" };
  if (tokenId.startsWith("nep141:base-")) return { label: "Base", short: "BASE", chain: "base" };
  if (tokenId.startsWith("nep141:arb-"))
    return { label: "Arbitrum", short: "ARB", chain: "arbitrum" };
  return { label: "NEAR", short: "NEAR", chain: "near" };
}
