import type { Claim, PaymentLogEntry } from "./claim";

// Deterministic fixtures for the screens until the API (S1a) is merged. The EVM debtor is the
// public test signer from fixtures/vectors/ack-v1.json: it never holds value.
export const TEST_SIGNER = "0x53C5D39A5828BaDf817E40f22d75d96D731f8239" as const;

const base: Omit<Claim, "tokenId" | "invoiceNumber" | "claimAccount" | "debtor" | "ack"> = {
  ownerId: "acme.near",
  issuerId: "acme.near",
  rootContract: "openrail.near",
  debtorName: "Northwind Studio",
  issuerName: "Acme Ltd",
  termsHash: "0x82c0dd15895dbb114c0d7d0e04b1123d62ec5ddacfeec9d067df71555b03edea",
  amountDue: 1_250_000_000n,
  dueDate: 1_800_086_400,
  status: "Issued",
  lock: { kind: "None" },
  bookedTotal: 0n,
  surplus: 0n,
  creditTotal: 0n,
};

export const mockClaims: Record<string, Claim> = {
  // Waiting for an EVM acknowledgement.
  "c-1": {
    ...base,
    tokenId: "c-1",
    invoiceNumber: "INV-0001",
    claimAccount: "c-1.openrail.near",
    debtor: { kind: "evm", address: TEST_SIGNER },
    ack: null,
  },
  // Waiting for a NEAR acknowledgement.
  "c-2": {
    ...base,
    tokenId: "c-2",
    invoiceNumber: "INV-0002",
    claimAccount: "c-2.openrail.near",
    debtor: { kind: "near", account: "northwind.near" },
    ack: null,
  },
  // Acknowledged, ready to sell.
  "c-3": {
    ...base,
    tokenId: "c-3",
    invoiceNumber: "INV-0003",
    claimAccount: "c-3.openrail.near",
    debtor: { kind: "evm", address: TEST_SIGNER },
    ack: { scheme: "evm", chainId: 8453, signer: TEST_SIGNER, block: 123_456 },
  },
  // REL-2 label: the token id and the account label agree without a `c-<n>` shape.
  "belmonte-9f3c2a7d41b8": {
    ...base,
    tokenId: "belmonte-9f3c2a7d41b8",
    invoiceNumber: "INV-0005",
    claimAccount: "belmonte-9f3c2a7d41b8.openrail.near",
    debtor: { kind: "near", account: "northwind.near" },
    ack: null,
  },
  // Paid without ever being acknowledged: can be neither accepted nor sold.
  "c-4": {
    ...base,
    tokenId: "c-4",
    invoiceNumber: "INV-0004",
    claimAccount: "c-4.openrail.near",
    debtor: { kind: "near", account: "northwind.near" },
    ack: null,
    status: "Paid",
    bookedTotal: 1_250_000_000n,
  },
};

const now = () => Math.floor(Date.now() / 1000);

export const mockPaymentLog = (tokenId: string): PaymentLogEntry[] =>
  tokenId === "c-3"
    ? [
        {
          kind: "Quote",
          quoteId: "q-demo-1",
          depositAddress: "0x9A4e0B3c5D7f1E2a4B6c8D0e2F4a6B8c0D2e4F6a",
          deadline: now() + 20 * 60,
          refundTo: TEST_SIGNER,
          routeId: "R1",
        },
        {
          kind: "Quote",
          quoteId: "q-demo-2",
          depositAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
          deadline: now() + 3 * 60,
          refundTo: "8vJc3FJ9xgrZ1p5vXq2YpE5f4uQ2zN7m1rT6uYhKsLwD",
          routeId: "R13",
        },
        {
          kind: "Quote",
          quoteId: "q-demo-old",
          depositAddress: "0x0000000000000000000000000000000000000001",
          deadline: now() - 60,
          refundTo: TEST_SIGNER,
          routeId: "R2",
        },
      ]
    : [];
