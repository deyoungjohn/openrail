import { describe, expect, it } from "vitest";
import { solanaTransferInstructions } from "./solana-pay";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FROM = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const TO = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5";

describe("solanaTransferInstructions", () => {
  it("creates the receiver's token account if needed, then a checked transfer of the exact amount", () => {
    const [create, transfer] = solanaTransferInstructions({
      from: FROM,
      to: TO,
      mint: USDC,
      amount: 10_010_000n,
      decimals: 6,
    });
    expect(create?.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    expect(transfer?.programId.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    // TransferChecked: instruction 12, then the amount (u64 LE) and the decimals.
    const data = Buffer.from(transfer?.data ?? []);
    expect(data[0]).toBe(12);
    expect(data.readBigUInt64LE(1)).toBe(10_010_000n);
    expect(data[9]).toBe(6);
  });

  it("the transfer signer is the payer and the mint is checked", () => {
    const [, transfer] = solanaTransferInstructions({
      from: FROM,
      to: TO,
      mint: USDC,
      amount: 1n,
      decimals: 6,
    });
    const keys = transfer?.keys.map((k) => k.pubkey.toBase58()) ?? [];
    expect(keys).toContain(FROM);
    expect(keys).toContain(USDC);
  });
});
