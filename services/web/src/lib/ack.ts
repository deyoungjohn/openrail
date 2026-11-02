import type { Hex } from "viem";

// Blueprint 2.7. Fixed by K14 on mainnet; fixtures/vectors/ack-v1.json checks every byte.

/** The six EVM chains of the pay-link routes. */
export const ACK_CHAIN_IDS = [1, 8453, 42161, 10, 137, 56] as const;

export const ACK_KIND = "OPENRAIL_ACK_V1";

export interface AckInput {
  chainId: number;
  rootContract: string;
  tokenId: string;
  termsHash: Hex;
  amountDue: bigint;
  dueDate: bigint;
}

export function ackTypedData(i: AckInput) {
  return {
    domain: {
      name: "Openrail",
      version: "1",
      chainId: i.chainId,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      Acknowledge: [
        { name: "kind", type: "string" },
        { name: "rootContract", type: "string" },
        { name: "tokenId", type: "string" },
        { name: "termsHash", type: "bytes32" },
        { name: "amountDue", type: "uint256" },
        { name: "dueDate", type: "uint64" },
      ],
    },
    primaryType: "Acknowledge",
    message: {
      kind: ACK_KIND,
      rootContract: i.rootContract,
      tokenId: i.tokenId,
      termsHash: i.termsHash,
      amountDue: i.amountDue,
      dueDate: i.dueDate,
    },
  } as const;
}

const EIP7702_DELEGATION = /^0xef0100[0-9a-f]{40}$/i;

/**
 * Can this account acknowledge with a plain ECDSA signature? EIP-1271 contract wallets cannot
 * (blueprint 2.7). An EOA that delegates through EIP-7702 has code `0xef0100` + a 20-byte address
 * and still signs with its own key, so it is allowed.
 */
export function canAckFromCode(code: string): boolean {
  return code === "0x" || code === "0x0" || EIP7702_DELEGATION.test(code);
}
