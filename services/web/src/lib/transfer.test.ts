import { describe, expect, it } from "vitest";
import type { Claim, PaymentLogEntry } from "./claim";
import { outstanding } from "./claim";
import { checkTransfer, openQuotes, sha256Hex } from "./transfer";

const HASH = "a".repeat(64);
const base: Claim = {
  tokenId: "c-1",
  invoiceNumber: "INV-0001",
  ownerId: "acme.near",
  issuerId: "acme.near",
  claimAccount: "c-1.openrail.near",
  rootContract: "openrail.near",
  debtor: { kind: "near", account: "buyer-co.near" },
  debtorName: "Buyer Co",
  issuerName: "Acme Ltd",
  termsHash: `0x${"11".repeat(32)}`,
  amountDue: 1_000_000n,
  dueDate: 1_800_000_000,
  ack: { scheme: "near", account: "buyer-co.near", block: 10 },
  status: "Issued",
  lock: { kind: "None" },
  bookedTotal: 0n,
  surplus: 0n,
  creditTotal: 0n,
};
const rules = { ackRequiredForSale: true, sellable: true };
const rulesOf = (c: Claim, receiver = "fund.near", doc = HASH, r = rules) =>
  checkTransfer(c, { receiver, assignmentDocHash: doc }, r).map((x) => x.rule);

describe("checkTransfer (blueprint 2.4)", () => {
  it("allows a sale of an acknowledged, unlocked, issued claim", () => {
    expect(rulesOf(base)).toEqual([]);
  });

  it("rule 1: refuses while a reconcile is running or a module holds a lock", () => {
    expect(rulesOf({ ...base, lock: { kind: "Reconciling", since: 5 } })).toEqual([1]);
    expect(rulesOf({ ...base, lock: { kind: "Module", id: "x", until: 9 } })).toEqual([1]);
  });

  it("rule 1: a transfer window is fine", () => {
    expect(rulesOf({ ...base, lock: { kind: "TransferWindow", until: 99 } })).toEqual([]);
  });

  it("rule 2: refuses Paid, Cancelled and Closed", () => {
    for (const status of ["Paid", "Cancelled", "Closed"] as const)
      expect(rulesOf({ ...base, status })).toEqual([2]);
    expect(rulesOf({ ...base, status: "PartiallyPaid" })).toEqual([]);
  });

  it("rule 3: refuses an unacknowledged claim (the Greensill rule), but not a transfer back to the issuer", () => {
    const unacked = { ...base, ack: null };
    expect(rulesOf(unacked)).toEqual([3]);
    expect(rulesOf({ ...unacked, ownerId: "fund.near" }, "acme.near", "")).toEqual([]);
  });

  it("rule 4: a sale needs a 64 hex character assignment document hash", () => {
    expect(rulesOf(base, "fund.near", "")).toEqual([4]);
    expect(rulesOf(base, "fund.near", "abc")).toEqual([4]);
    expect(rulesOf(base, "fund.near", "z".repeat(64))).toEqual([4]);
    expect(rulesOf(base, "fund.near", "A".repeat(64))).toEqual([]);
  });

  it("rule 5: the receiver cannot be the claim account", () => {
    expect(rulesOf(base, "c-1.openrail.near")).toEqual([5]);
  });

  it("rule 7: refuses kinds that are not sellable", () => {
    expect(rulesOf(base, "fund.near", HASH, { ...rules, sellable: false })).toEqual([7]);
  });

  it("reports every broken rule, in order, with the rule number in plain words", () => {
    const out = checkTransfer(
      { ...base, status: "Paid", ack: null },
      { receiver: "c-1.openrail.near", assignmentDocHash: "" },
      rules,
    );
    expect(out.map((r) => r.rule)).toEqual([2, 3, 4, 5]);
    for (const r of out) expect(r.message).toMatch(new RegExp(`^Rule ${r.rule}: `));
  });

  it("refuses an empty or malformed receiver account", () => {
    expect(checkTransfer(base, { receiver: "", assignmentDocHash: HASH }, rules)).not.toEqual([]);
    expect(
      checkTransfer(base, { receiver: "Not An Account", assignmentDocHash: HASH }, rules),
    ).not.toEqual([]);
  });
});

describe("openQuotes (the cut-off list)", () => {
  const log: PaymentLogEntry[] = [
    {
      kind: "Quote",
      quoteId: "q1",
      depositAddress: "0xaaa",
      deadline: 2000,
      refundTo: "0xr1",
      routeId: "R1",
    },
    {
      kind: "Quote",
      quoteId: "q2",
      depositAddress: "0xbbb",
      deadline: 1000,
      refundTo: "0xr2",
      routeId: "R9",
    },
    { kind: "Other" },
  ];
  it("lists only quotes whose deadline has not passed, soonest first", () => {
    expect(openQuotes(log, 1500).map((q) => q.quoteId)).toEqual(["q1"]);
    expect(openQuotes(log, 500).map((q) => q.quoteId)).toEqual(["q2", "q1"]);
    expect(openQuotes(log, 3000)).toEqual([]);
  });
});

describe("sha256Hex", () => {
  it("hashes bytes to 64 lowercase hex characters", async () => {
    const h = await sha256Hex(new TextEncoder().encode("abc"));
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("outstanding (blueprint 2.3)", () => {
  it("is amount due minus (booked minus surplus) minus credit", () => {
    expect(outstanding({ ...base, bookedTotal: 400_000n })).toBe(600_000n);
    expect(outstanding({ ...base, bookedTotal: 1_200_000n, surplus: 200_000n })).toBe(0n);
    expect(outstanding({ ...base, bookedTotal: 100_000n, creditTotal: 50_000n })).toBe(850_000n);
  });
});
