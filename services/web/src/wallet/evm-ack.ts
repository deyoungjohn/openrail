import { createWalletClient, custom, getAddress, type EIP1193Provider } from "viem";
import { ACK_CHAIN_IDS, ackTypedData, canAckFromCode } from "../lib/ack";
import type { Claim } from "../lib/claim";

export type EvmAckError =
  "NO_WALLET" | "WRONG_ACCOUNT" | "UNSUPPORTED_CHAIN" | "CONTRACT_WALLET" | "REJECTED";

export class EvmAckFailure extends Error {
  constructor(public readonly code: EvmAckError) {
    super(code);
  }
}

/**
 * Signs the Acknowledge message (blueprint 2.7) with the injected wallet. All the checks run before
 * the wallet is asked, so the client sees a plain refusal instead of a wallet error.
 */
export async function signEvmAck(
  provider: EIP1193Provider | undefined,
  claim: Claim,
): Promise<{ chainId: number; signature: `0x${string}` }> {
  if (!provider) throw new EvmAckFailure("NO_WALLET");
  if (claim.debtor?.kind !== "evm") throw new EvmAckFailure("WRONG_ACCOUNT");

  const wallet = createWalletClient({ transport: custom(provider) });
  const [account] = await wallet.requestAddresses().catch(() => {
    throw new EvmAckFailure("REJECTED");
  });
  if (!account || getAddress(account) !== getAddress(claim.debtor.address))
    throw new EvmAckFailure("WRONG_ACCOUNT");

  const chainId = await wallet.getChainId();
  if (!(ACK_CHAIN_IDS as readonly number[]).includes(chainId))
    throw new EvmAckFailure("UNSUPPORTED_CHAIN");

  // EIP-1271 is not supported: a contract account has code (an EIP-7702 delegated EOA is fine).
  const code = await provider
    .request({ method: "eth_getCode", params: [account, "latest"] })
    .catch(() => "0x");
  if (typeof code === "string" && !canAckFromCode(code)) throw new EvmAckFailure("CONTRACT_WALLET");

  try {
    const signature = await wallet.signTypedData({
      account,
      ...ackTypedData({
        chainId,
        rootContract: claim.rootContract,
        tokenId: claim.tokenId,
        termsHash: claim.termsHash,
        amountDue: claim.amountDue,
        dueDate: BigInt(claim.dueDate),
      }),
    });
    return { chainId, signature };
  } catch {
    throw new EvmAckFailure("REJECTED");
  }
}
