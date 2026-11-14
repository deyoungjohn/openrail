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
    // Where each share of the given claims really is: the contract's status, and for a payout still marked in flight,
    // the provider's word on its deposit address (the worker reports it to the contract later). The dashboard asks only
    // for the shares its events still show as held or on the way.
    if (request.path === "/v1/business/held/state" && request.method === "GET") {
      const auth = context.requireAuth(request);
      context.requireScope(auth, "invoices:read");
      const ids = (request.query.get("token_ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => /^[A-Za-z0-9._-]{1,128}$/.test(id))
        .slice(0, 50);
      const out: {
        token_id: string;
        index: number;
        state: "held" | "sending" | "settled" | "returned" | "released";
        tx: string | null;
      }[] = [];
      for (const tokenId of ids) {
        const held = await context.view("settle_held", { token_id: tokenId });
        const entries = Array.isArray(held) ? (held as Record<string, unknown>[]) : [];
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index] ?? {};
          const status = entry.status as unknown;
          if (status !== null && typeof status === "object" && "Settled" in status) {
            const s = (status as { Settled: { destination_tx?: unknown } }).Settled;
            out.push({
              token_id: tokenId,
              index,
              state: "settled",
              tx: typeof s.destination_tx === "string" ? s.destination_tx : null,
            });
          } else if (status !== null && typeof status === "object" && "InFlight" in status) {
            const payoutId = (status as { InFlight: { payout_id: number } }).InFlight.payout_id;
            let state: "sending" | "settled" | "returned" = "sending";
            let tx: string | null = null;
            try {
              const payout = (await context.view("payout", { payout_id: payoutId })) as {
                deposit_address?: unknown;
              } | null;
              const address =
                typeof payout?.deposit_address === "string" ? payout.deposit_address : "";
              const live = address === "" ? undefined : await context.providerStatus?.(address);
              if (live?.status === "SUCCESS") {
                state = "settled";
                tx = live.destinationChainTxHashes?.[0] ?? live.nearTxHashes?.[0] ?? null;
              } else if (live?.status === "REFUNDED" || live?.status === "FAILED")
                state = "returned";
            } catch {
              /* the provider or the chain cannot say now: keep "on its way" */
            }
            out.push({ token_id: tokenId, index, state, tx });
          } else if (status !== null && typeof status === "object" && "Flagged" in status) {
            out.push({ token_id: tokenId, index, state: "returned", tx: null });
          } else if (status !== null && typeof status === "object" && "Released" in status) {
            out.push({ token_id: tokenId, index, state: "released", tx: null });
          } else out.push({ token_id: tokenId, index, state: "held", tx: null });
        }
      }
      return { status: 200, body: { data: out } };
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
