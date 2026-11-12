/** A USDC (SPL token) transfer to a deposit address, built for the connected wallet to sign. */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";

export const SOLANA_RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export interface SolanaTransferRequest {
  from: string;
  to: string;
  mint: string;
  amount: bigint;
  decimals: number;
}

/** The instructions only (no network): the receiver's token account is created when it does not exist yet. */
export function solanaTransferInstructions(r: SolanaTransferRequest) {
  const owner = new PublicKey(r.from);
  const receiver = new PublicKey(r.to);
  const mint = new PublicKey(r.mint);
  const source = getAssociatedTokenAddressSync(mint, owner);
  const destination = getAssociatedTokenAddressSync(mint, receiver, true);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, destination, receiver, mint),
    createTransferCheckedInstruction(source, mint, destination, owner, r.amount, r.decimals),
  ];
}

export async function buildSolanaUsdcTransfer(r: SolanaTransferRequest) {
  if (r.amount <= 0n) throw new Error("invalid_amount");
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const { blockhash } = await connection.getLatestBlockhash();
  const transaction = new Transaction({
    feePayer: new PublicKey(r.from),
    recentBlockhash: blockhash,
  });
  transaction.add(...solanaTransferInstructions(r));
  return { transaction, connection };
}
