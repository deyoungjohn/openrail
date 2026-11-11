/** Pure parts of the private-balance withdrawal: the exact payload the wallet signs and what is sent back. */

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

/** What the merchant is shown before signing: refuse a payload that is not for the intents contract. */
export function checkIntent(intent: WithdrawIntent): void {
  if (intent.standard !== "nep413") throw new Error("UNEXPECTED_INTENT_STANDARD");
  if (intent.payload.recipient !== "intents.near") throw new Error("UNEXPECTED_INTENT_RECIPIENT");
}
