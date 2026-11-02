// Pure invoice logic for the issue form, claim detail and dashboard. Money is bigint cents or
// USDC base units and is never rounded.

const CENTS = /^\d+\.\d{2}$/;
const QTY = /^\d+(\.\d{1,2})?$/;
const NEAR_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** An API amount like `12.50` as cents, or null when it is not exactly two decimals. */
export function parseCents(s: string): bigint | null {
  return CENTS.test(s) ? BigInt(s.replace(".", "")) : null;
}

/** Quantity (up to 2 decimals) times a unit price, or null when it is invalid or not a whole cent. */
export function lineCents(quantity: string, unit: string): bigint | null {
  if (!QTY.test(quantity)) return null;
  const unitCents = parseCents(unit);
  if (unitCents === null || unitCents === 0n) return null;
  const [w = "0", f = ""] = quantity.split(".");
  const hundredths = BigInt(w) * 100n + BigInt(f.padEnd(2, "0"));
  if (hundredths === 0n) return null;
  const product = unitCents * hundredths;
  return product % 100n === 0n ? product / 100n : null;
}

export interface LineForm {
  description: string;
  quantity: string;
  unit: string;
}

export function invoiceTotalCents(lines: readonly LineForm[]): bigint | null {
  let total = 0n;
  for (const l of lines) {
    const c = lineCents(l.quantity, l.unit);
    if (c === null) return null;
    total += c;
  }
  return total;
}

export interface IssueForm {
  invoiceNumber: string;
  debtorName: string;
  debtorType: "near" | "evm";
  debtorKey: string;
  /** `YYYY-MM-DD`. */
  dueDate: string;
  lines: LineForm[];
}

/** Field errors keyed by field; `line.<i>.description` and `line.<i>.amount` for lines. */
export function validateIssue(f: IssueForm, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.invoiceNumber.trim() === "") e.invoiceNumber = "Enter an invoice number.";
  if (f.debtorName.trim() === "") e.debtorName = "Enter your client's name.";
  const key = f.debtorKey.trim();
  if (f.debtorType === "near" ? !NEAR_ACCOUNT.test(key) : !EVM_ADDRESS.test(key))
    e.debtorKey =
      f.debtorType === "near"
        ? "Enter a valid NEAR account, like client.near."
        : "Enter a valid wallet address that starts with 0x.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dueDate)) e.dueDate = "Pick a due date.";
  else if (f.dueDate <= today) e.dueDate = "Pick a due date after today.";
  if (f.lines.length === 0) e.lines = "Add at least one line.";
  f.lines.forEach((l, i) => {
    if (l.description.trim() === "") e[`line.${i}.description`] = "Describe this line.";
    if (lineCents(l.quantity, l.unit) === null)
      e[`line.${i}.amount`] = "Use a quantity and a price that make a whole number of cents.";
  });
  return e;
}

// ---- claim detail --------------------------------------------------------------------------

export interface Counters {
  amount_due: string;
  booked_total: string;
  distributed_total: string;
  fee_total: string;
  surplus: string;
  credit_total: string;
}

/** Blueprint 2.3: amount_due - (booked_total - surplus) - credit_total. */
export const outstandingUnits = (c: Counters): bigint =>
  BigInt(c.amount_due) - (BigInt(c.booked_total) - BigInt(c.surplus)) - BigInt(c.credit_total);

export type CounterKey =
  | "amount_due"
  | "booked_total"
  | "distributed_total"
  | "fee_total"
  | "surplus"
  | "credit_total"
  | "outstanding";

/** Every counter of `claim()` as exact USDC base units, in reading order. */
export function claimRows(c: Counters): { key: CounterKey; value: bigint }[] {
  return [
    { key: "amount_due", value: BigInt(c.amount_due) },
    { key: "booked_total", value: BigInt(c.booked_total) },
    { key: "distributed_total", value: BigInt(c.distributed_total) },
    { key: "fee_total", value: BigInt(c.fee_total) },
    { key: "surplus", value: BigInt(c.surplus) },
    { key: "credit_total", value: BigInt(c.credit_total) },
    { key: "outstanding", value: outstandingUnits(c) },
  ];
}

// ---- lists and dashboard -------------------------------------------------------------------

type ApiStatus = "Issued" | "PartiallyPaid" | "Paid" | "Cancelled" | "Closed";

export type ChipStatus =
  | { kind: "sent" }
  | { kind: "acknowledged" }
  | { kind: "partial"; due?: string }
  | { kind: "paid" }
  | { kind: "overdue"; days: number }
  | { kind: "closed" }
  | { kind: "cancelled" };

const DAY = 86_400;
const dueSec = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / 1000;

const isOpen = (s: ApiStatus) => s === "Issued" || s === "PartiallyPaid";

/** The chip for an invoice. Overdue is derived: a whole day past due and still open (blueprint 2.3). */
export function chipFor(
  inv: { status: ApiStatus; due_date: string },
  nowSec: number,
  acknowledged: boolean,
): ChipStatus {
  switch (inv.status) {
    case "Paid":
      return { kind: "paid" };
    case "Cancelled":
      return { kind: "cancelled" };
    case "Closed":
      return { kind: "closed" };
    default: {
      const days = Math.floor((nowSec - dueSec(inv.due_date)) / DAY);
      if (days >= 1) return { kind: "overdue", days };
      if (inv.status === "PartiallyPaid") return { kind: "partial" };
      return acknowledged ? { kind: "acknowledged" } : { kind: "sent" };
    }
  }
}

export interface Summary {
  counts: { all: number; paid: number; waiting: number; overdue: number };
  paidCents: bigint;
  outstandingCents: bigint;
  overdueCents: bigint;
  topClients: { name: string; totalCents: bigint }[];
}

export function summarize(
  list: readonly {
    status: ApiStatus;
    due_date: string;
    amount_usd: string;
    debtor_legal_name: string;
  }[],
  nowSec: number,
): Summary {
  const s: Summary = {
    counts: { all: list.length, paid: 0, waiting: 0, overdue: 0 },
    paidCents: 0n,
    outstandingCents: 0n,
    overdueCents: 0n,
    topClients: [],
  };
  const clients = new Map<string, bigint>();
  for (const i of list) {
    if (i.status === "Cancelled") continue;
    const cents = parseCents(i.amount_usd) ?? 0n;
    clients.set(i.debtor_legal_name, (clients.get(i.debtor_legal_name) ?? 0n) + cents);
    if (i.status === "Paid") {
      s.counts.paid += 1;
      s.paidCents += cents;
    } else if (isOpen(i.status)) {
      s.outstandingCents += cents;
      if (chipFor(i, nowSec, false).kind === "overdue") {
        s.counts.overdue += 1;
        s.overdueCents += cents;
      } else s.counts.waiting += 1;
    }
  }
  s.topClients = [...clients]
    .map(([name, totalCents]) => ({ name, totalCents }))
    .sort((a, b) =>
      a.totalCents === b.totalCents
        ? a.name.localeCompare(b.name)
        : a.totalCents > b.totalCents
          ? -1
          : 1,
    );
  return s;
}
