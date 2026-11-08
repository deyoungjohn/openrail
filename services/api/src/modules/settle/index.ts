/** Settle module API surface: the merchant's held balance and the worker's schedule read. */
import type { ApiModule, ApiModuleContext } from "../../modules.js";
import { ApiError } from "../../app.js";

interface HeldRow {
  token_id: string;
  index: number;
  asset: string;
  amount: string;
  status: unknown;
  retries: number;
  destination: unknown;
  settle_release: boolean;
}

function heldRows(tokenId: string, entries: Record<string, unknown>[]): HeldRow[] {
  return entries.map((entry, index) => ({
    token_id: tokenId,
    index,
    asset: typeof entry.asset === "string" ? entry.asset : "",
    amount:
      typeof entry.amount === "string"
        ? entry.amount
        : typeof entry.amount === "number"
          ? String(entry.amount)
          : "0",
    status: entry.status ?? "Held",
    retries: typeof entry.retries === "number" ? entry.retries : 0,
    destination: entry.destination ?? null,
    settle_release: entry.status === "Held" || entry.status === undefined,
  }));
}

export const apiModule: ApiModule = {
  id: "settle",
  async route(request, context: ApiModuleContext) {
    if (request.path === "/v1/business/held" && request.method === "GET") {
      const auth = context.requireAuth(request);
      context.requireScope(auth, "invoices:read");
      const rows: HeldRow[] = [];
      const view = (
        context as unknown as {
          view(method: string, args: object): Promise<unknown>;
        }
      ).view.bind(context);
      for (const invoice of context.store.listInvoices(auth.accountId)) {
        const held = await view("settle_held", { token_id: invoice.token_id });
        const entries = Array.isArray(held) ? (held as Record<string, unknown>[]) : [];
        rows.push(...heldRows(invoice.token_id, entries));
      }
      const totals = new Map<string, bigint>();
      for (const row of rows) {
        if (!row.settle_release) continue;
        totals.set(row.asset, (totals.get(row.asset) ?? 0n) + BigInt(row.amount));
      }
      return {
        status: 200,
        body: {
          entries: rows,
          totals: [...totals.entries()].map(([asset, amount]) => ({
            asset,
            amount: amount.toString(),
          })),
        },
      };
    }
    if (request.path === "/v1/internal/payout_settings" && request.method === "GET") {
      const key = process.env.PAYOUT_INTERNAL_KEY ?? "";
      if (key === "" || request.headers["x-openrail-internal-key"] !== key)
        throw new ApiError(401, "unauthorized");
      const tokenId = request.query.get("token_id") ?? "";
      const invoice = context.store.getInvoice(tokenId);
      if (invoice === undefined) throw new ApiError(404, "invoice_not_found");
      const business = context.store.getBusiness(invoice.issuer_id) as
        { payout?: { schedule: string; destination: string | null } } | undefined;
      return {
        status: 200,
        body: business?.payout ?? { schedule: "manual", destination: null },
      };
    }
    return undefined;
  },
};
