/** Wire shapes for the settle/payout views and 1Click. */

export type HeldStatus =
  | "Held"
  | { InFlight: { payout_id: number } }
  | { Settled: { payout_id: number; destination_tx: string } }
  | { Flagged: { reason: string } }
  | { Released: { payout_id: number } };

export interface Destination {
  chain: string;
  address: string;
  min_amount: string;
}

export interface HeldEntry {
  owner: string;
  asset: string;
  amount: string;
  status: HeldStatus;
  retries: number;
  destination: Destination | null;
}

export interface PayoutRecord {
  id: number;
  module_id: string;
  reference: string;
  source: string;
  asset: string;
  amount_in: string;
  deposit_address: string;
  status: string;
  created_block: number;
}

export type PayoutOutcome =
  { Settled: { destination_tx: string } } | { Refunded: { amount: string } };

export interface CheckoutRefundEvent {
  tokenId: string;
  refundTo: string;
  amount: string;
  asset: string;
  status?:
    "Pending" | { InFlight: { payout_id: number } } | { Settled: { destination_tx: string } };
}

export interface ChainPort {
  settleHeld(tokenId: string): Promise<HeldEntry[]>;
  settlementOf(owner: string): Promise<Destination | null>;
  claimAccount(tokenId: string): Promise<string>;
  settlePayout(
    tokenId: string,
    index: number,
    depositAddress: string,
    amountIn: string,
  ): Promise<{ payoutId: number; txHash: string }>;
  reportPayout(
    tokenId: string,
    index: number,
    payoutId: number,
    outcome: PayoutOutcome,
  ): Promise<void>;
  payout(payoutId: number): Promise<PayoutRecord | null>;
  balanceYocto(): Promise<bigint>;

  // Checkout refund support:
  checkoutRefundEvents?(tokenId: string): Promise<CheckoutRefundEvent[]>;
  bookedNet?(tokenId: string): Promise<string>;
  refundLate?(
    tokenId: string,
    depositAddress: string,
    amountIn: string,
  ): Promise<{ payoutId: number; txHash: string }>;
}

export interface QuoteRequest {
  asset: string;
  amount: string;
  destination: Destination;
  refundTo: string;
  deadline: string;
}

export interface Quote {
  amountIn: string;
  depositAddress: string;
  recipient: string;
  destinationAsset?: string;
  deadline: string;
}

export interface QuotePort {
  quote(request: QuoteRequest): Promise<Quote>;
}

export interface StatusRecord {
  status: string;
  destinationTxHashes: { hash: string; explorerUrl?: string }[];
  refundedAmount?: string;
}

export interface StatusPort {
  status(depositAddress: string): Promise<StatusRecord>;
}

export interface HeldDiscovery {
  tokens(): Promise<string[]>;
}

export interface WorkerSummary {
  tokens: number;
  held: number;
  sent: string[];
  settled: string[];
  refunded: string[];
  skipped: string[];
  errors: string[];
}
