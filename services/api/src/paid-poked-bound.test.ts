import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createMemoryStores } from "./stores.js";

describe("paid-poked cache", () => {
  it("keeps only the last 500 ids and pokes again after eviction", async () => {
    const stores = createMemoryStores();
    const auth = new AuthStore(() => Date.parse("2026-11-11T10:00:00Z"));
    const poke = vi.fn(async () => undefined);
    const deps: ApiDeps = {
      config: {
        rootAccount: "openrail.near",
        recipient: "api.near",
        payBaseUrl: "https://pay.test",
      },
      store: stores.api,
      docs: stores.docs,
      auth,
      issuer: {} as never,
      contract: {
        claim: vi.fn(async () => ({
          status: "Paid",
          amount_due: "100",
          booked_total: "100",
          surplus: "0",
          credit_total: "0",
          fee_total: "0",
          distributed_total: "100",
        })),
      } as never,
      accessKey: { has: async () => true },
      cashout: { quote: vi.fn() },
      pokeIndexer: poke,
      clock: () => new Date("2026-11-11T10:00:00Z"),
    };
    const app = new ApiApp(deps);
    for (let i = 0; i < 501; i += 1) {
      stores.api.saveInvoice({
        id: `inv_${i}`,
        token_id: `c-${i}`,
        claim_account: `c-${i}.openrail.near`,
        status: "Issued",
        issuer_id: "acme.near",
        owner_id: "acme.near",
        debtor: null,
        terms_hash: "0x" + "a".repeat(64),
        amount_due: "100",
        outstanding: "100",
        paid_total: "0",
        amount_usd: "0.00",
        due_date: "2026-12-01",
        invoice_number: `INV-${i}`,
        issuer_legal_name: "Acme",
        debtor_legal_name: "Client",
        pay_link: "https://pay.test/x",
        ack_url: "https://pay.test/ack",
        created_at: "2026-11-11T10:00:00Z",
        created_block: 1,
        terms: {} as never,
      });
    }
    const read = (i: number) =>
      app.handle({
        method: "GET",
        path: `/v1/pay/claims/c-${i}`,
        query: new URLSearchParams(),
        headers: {},
        body: undefined,
      });
    await read(0);
    for (let i = 1; i < 501; i += 1) await read(i);
    expect(poke).toHaveBeenCalledTimes(501);
    await read(0);
    expect(poke).toHaveBeenCalledTimes(502);
  });
});
