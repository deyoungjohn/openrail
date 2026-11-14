/**
 * The payload a merchant's wallet signs to open a private-balance session with the provider (NEP-413, an empty intent).
 *
 * The intents contract accepts only a versioned nonce, and the provider checks the time window (12 Nov, CLI runbook
 * "What it took"). 32 bytes:
 *   magic 5628f6c6 | 00 (V1) | the contract's current salt (4 bytes) | deadline (i64 ns, LE) | start = now (i64 ns, LE)
 *   | 7 random bytes.
 * The deadline is 4 minutes ahead (the provider allows 5), whole seconds, the same instant in the message and the nonce.
 */

export const AUTH_WINDOW_MS = 4 * 60_000;
const MAGIC = [0x56, 0x28, 0xf6, 0xc6];

export interface ConfidentialAuthPayload {
  standard: "nep413";
  payload: { message: string; nonce: string; recipient: "intents.near" };
}

function i64le(value: bigint): number[] {
  const out: number[] = [];
  let v = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i += 1) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

export function versionedNonce(
  saltHex: string,
  deadlineMs: number,
  nowMs: number,
  random7: Uint8Array,
): Uint8Array {
  const salt = saltHex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{8}$/.test(salt)) throw new Error("BAD_SALT");
  if (random7.length !== 7) throw new Error("BAD_RANDOM");
  const bytes = [
    ...MAGIC,
    0x00,
    ...(salt.match(/../g) as string[]).map((h) => parseInt(h, 16)),
    ...i64le(BigInt(deadlineMs) * 1_000_000n),
    ...i64le(BigInt(nowMs) * 1_000_000n),
    ...random7,
  ];
  return Uint8Array.from(bytes);
}

export function confidentialAuthPayload(
  accountId: string,
  saltHex: string,
  nowMs: number,
  random7: Uint8Array,
): ConfidentialAuthPayload {
  const deadlineMs = Math.floor((nowMs + AUTH_WINDOW_MS) / 1000) * 1000;
  const message = JSON.stringify({
    deadline: new Date(deadlineMs).toISOString(),
    intents: [],
    signer_id: accountId,
  });
  const nonce = Buffer.from(versionedNonce(saltHex, deadlineMs, nowMs, random7)).toString("base64");
  return { standard: "nep413", payload: { message, nonce, recipient: "intents.near" } };
}
