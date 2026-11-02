/** Refund/destination address validation per route chain. */
import { baseDecode } from "near-api-js";
import { getAddress } from "viem";

export class AddressError extends Error {
  override readonly name = "AddressError";
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

const EVM_CHAINS = new Set(["base", "arbitrum", "ethereum", "optimism", "polygon", "bnb"]);

function validateEvm(address: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new AddressError("invalid_refund_address");
  const mixedCase = address !== address.toLowerCase() && address !== address.toUpperCase();
  if (mixedCase && getAddress(address) !== address) {
    throw new AddressError("invalid_refund_address", "EIP-55 checksum mismatch");
  }
}

function validateSolana(address: string): void {
  try {
    if (baseDecode(address).length !== 32) throw new Error("length");
  } catch {
    throw new AddressError("invalid_refund_address");
  }
}

function validateNear(address: string): void {
  const valid =
    address.length >= 2 &&
    address.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(address);
  if (!valid) throw new AddressError("invalid_refund_address");
}

/** Throws AddressError with `invalid_refund_address` for a bad origin-chain address. */
export function validateRefundAddress(chain: string, address: string): void {
  if (address === "") throw new AddressError("invalid_refund_address");
  if (EVM_CHAINS.has(chain)) return validateEvm(address);
  if (chain === "solana") return validateSolana(address);
  if (chain === "near") return validateNear(address);
  throw new AddressError("unsupported_chain");
}
