import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { createMemoryStores } from "./stores.js";

function harness(lastPolledAt: string | null) {
  let now = Date.parse("2026-11-11T10:00:00Z");
  const auth = new AuthStore(() => now);
  const { secret } = auth.createApiKey("acme.near", "Production", "secret", ["invoices:read"]);
  const poke = vi.fn(async () => undefined);
  const status = vi.fn(async () => ({ last_polled_at: lastPolledAt, boost_active: false }));
  const deps: ApiDeps = {
    config: { rootAccount: "openrail.near", recipient: "api.near", payBaseUrl: "https://pay.test" },
    store: createMemoryStores().api,
    auth,
    issuer: {} as never,
    contract: {} as never,
    accessKey: { has: async () => true },
    cashout: { quote: vi.fn() },
    indexer: {
      status,
      listReceipts: vi.fn(),
      getReceipt: vi.fn(),
      getStatement: vi.fn(),
      listEvents: vi.fn(),
      analytics: vi.fn(),
    } as never,
    pokeIndexer: poke,
    clock: () => new Date(now),
  };
  const app = new ApiApp(deps);
  const request = (method: string, path: string) => ({
    method,
    path,
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${secret}` },
    body: undefined,
  });
  return { app, request, poke, status, advance: (ms: number) => (now += ms) };
}

describe("dashboard freshness", () => {
  it("pokes once for stale data and N reads in a minute do not poke again", async () => {
    const { app, request, poke } = harness("2026-11-11T09:00:00Z");
    const first = await app.handle(request("GET", "/v1/invoices"));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      meta: { last_polled_at: "2026-11-11T09:00:00Z", boost_active: true },
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await app.handle(request("GET", "/v1/invoices"));
      expect(response.status).toBe(200);
    }
    expect(poke).toHaveBeenCalledTimes(1);
  });

  it("does not poke when the last poll is under five minutes old", async () => {
    const { app, request, poke } = harness("2026-11-11T09:58:00Z");
    const response = await app.handle(request("GET", "/v1/invoices"));
    expect(response.body).toMatchObject({ meta: { boost_active: false } });
    expect(poke).not.toHaveBeenCalled();
  });
});
