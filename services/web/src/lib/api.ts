import type { Claim, PaymentLogEntry } from "./claim";
import { mockClaims, mockPaymentLog } from "./mock-data";

// The one place screens read from. Until the OpenAPI (S1a) is merged this is a fixture-backed
// mock; the live client replaces `mockApi` and the screens do not change.
export interface OpenrailApi {
  /** `null` when no such invoice exists. */
  getClaim(tokenId: string): Promise<Claim | null>;
  getPaymentLog(tokenId: string): Promise<PaymentLogEntry[]>;
  /** Hands an EIP-712 signature to Openrail, which relays `acknowledge_evm` for the client. */
  relayEvmAck(tokenId: string, chainId: number, signature: `0x${string}`): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const mockApi: OpenrailApi = {
  async getClaim(tokenId) {
    await wait(300);
    if (tokenId === "c-error") throw new Error("MOCK_ERROR");
    // Fixture mode only: hold the answer back so a test can look at the loading state.
    if (tokenId === "c-slow") await wait(8000);
    return mockClaims[tokenId] ?? null;
  },
  async getPaymentLog(tokenId) {
    await wait(300);
    return mockPaymentLog(tokenId);
  },
  async relayEvmAck() {
    await wait(600);
  },
};

export const api: OpenrailApi = mockApi;

/** True while screens run on fixtures, so nothing signs against a real contract. */
export const MOCK_MODE = process.env.NEXT_PUBLIC_API_MODE !== "live";
