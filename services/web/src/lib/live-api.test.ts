import { describe, expect, it } from "vitest";
import { claimFromView, paymentLogFromQuotes, type ClaimViewJson } from "./live-api";

const VIEW: ClaimViewJson = {
  token_id: "c-1",
  issuer_id: "nearhackathons.near",
  owner_id: "nearhackathons.near",
  claim_account: "c-1.openrail.near",
  debtor: { Evm: "0x12dcbbc7f96b87220e90b46d9528db156b1da841" },
  terms_hash: "0x" + "ab".repeat(32),
  amount_due: "3000000",
  due_date: 1_794_000_000,
  ack: null,
  status: "Issued",
  lock: "None",
  booked_total: "0",
  surplus: "0",
  credit_total: "0",
};

describe("claimFromView: the contract's own answer becomes the screens' claim", () => {
  it("maps an unacknowledged claim owed by an EVM wallet", () => {
    const c = claimFromView(
      VIEW,
      { invoiceNumber: "G1-1", issuerName: "Openrail", debtorName: "G1 debtor" },
      "openrail.near",
    );
    expect(c.debtor).toEqual({
      kind: "evm",
      address: "0x12dcbbc7f96b87220e90b46d9528db156b1da841",
    });
    expect(c.amountDue).toBe(3_000_000n);
    expect(c.ack).toBeNull();
    expect(c.lock).toEqual({ kind: "None" });
    expect(c.rootContract).toBe("openrail.near");
    expect(c.invoiceNumber).toBe("G1-1");
  });
  it("shows the debtor the contract knows, never one invented by a fixture", () => {
    const c = claimFromView(VIEW);
    expect(c.debtor).toMatchObject({ kind: "evm" });
    expect(c.invoiceNumber).toBe("c-1");
    expect(c.issuerName).toBe("nearhackathons.near");
  });
  it("maps an EVM acknowledgement, a NEAR debtor and a held lock", () => {
    const c = claimFromView({
      ...VIEW,
      debtor: { Near: "client.near" },
      ack: { scheme: { Evm: { chain_id: 8453, signer: "0x" + "e".repeat(40) } }, block: 9 },
      lock: { Reconciling: { since: 123 } },
      status: "PartiallyPaid",
      booked_total: "1000000",
    });
    expect(c.debtor).toEqual({ kind: "near", account: "client.near" });
    expect(c.ack).toEqual({
      scheme: "evm",
      chainId: 8453,
      signer: "0x" + "e".repeat(40),
      block: 9,
    });
    expect(c.lock).toEqual({ kind: "Reconciling", since: 123 });
    expect(c.bookedTotal).toBe(1_000_000n);
  });
});

describe("paymentLogFromQuotes", () => {
  it("maps the contract's quote records", () => {
    expect(
      paymentLogFromQuotes([
        {
          quote_id: "q1",
          deposit_address: "0xd",
          deadline_requested: 5,
          refund_to: "0xr",
          route_id: "R1",
        },
      ]),
    ).toEqual([
      {
        kind: "Quote",
        quoteId: "q1",
        depositAddress: "0xd",
        deadline: 5,
        refundTo: "0xr",
        routeId: "R1",
      },
    ]);
  });
});
