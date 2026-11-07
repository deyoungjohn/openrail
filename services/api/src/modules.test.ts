import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ApiApp, ApiError, type ApiDeps } from "./app.js";
import { AuthStore } from "./auth.js";
import { enabledModules } from "./enabled.js";
import {
  apiModulesFrom,
  createMemoryModuleStore,
  createSqliteModuleStore,
  expandEvents,
  type ApiModule,
  type ApiModuleContext,
} from "./modules.js";
import { createSqliteStores } from "./stores.js";
import { WebhookWorker } from "./webhook-worker.js";
import type { IndexedEvent } from "./webhooks.js";

function deps(modules: ApiModule[]): ApiDeps {
  return {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.openrail.near",
      payBaseUrl: "https://p",
    },
    auth: new AuthStore(() => 0),
    issuer: {
      prepareIssue: vi.fn(),
      issueFor: vi.fn(),
      logQuote: vi.fn(),
      acknowledgeEvm: vi.fn(),
    },
    contract: { claim: vi.fn(), storageCredit: vi.fn() },
    accessKey: { has: async () => true },
    verifier: () => true,
    cashout: { quote: async () => ({}) },
    modules,
  };
}

function get(path: string) {
  return { method: "GET", path, query: new URLSearchParams(), headers: {}, body: undefined };
}

const example: ApiModule = {
  id: "example",
  route: async (request, context) => {
    if (request.path === "/v1/example/open") return { status: 200, body: { ok: true } };
    if (request.path === "/v1/example/private") {
      context.requireAuth(request);
      return { status: 200, body: {} };
    }
    if (request.path === "/v1/example/teapot") throw new ApiError(418, "teapot");
    return undefined;
  },
  events: (event) =>
    event.type === "thing" ? [{ ...event, id: `${event.id}:example`, type: "example.thing" }] : [],
};

describe("API module host", () => {
  it("module_routes_dispatched_after_core", async () => {
    const app = new ApiApp(deps([example]));
    expect(await app.handle(get("/v1/example/open"))).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect((await app.handle(get("/v1/example/private"))).status).toBe(401);
    expect((await app.handle(get("/v1/example/teapot"))).status).toBe(418);
    expect((await app.handle(get("/v1/example/none"))).status).toBe(404);
  });

  it("module_absent_means_route_absent", async () => {
    const app = new ApiApp(deps([]));
    expect((await app.handle(get("/v1/example/open"))).status).toBe(404);
  });

  it("module_events_follow_the_original", () => {
    const app = new ApiApp(deps([example]));
    const event = { id: "7", type: "thing", created: 1, data: {} } as unknown as IndexedEvent;
    expect(expandEvents(event, app.modules, app.moduleContext).map((e) => e.type)).toEqual([
      "thing",
      "example.thing",
    ]);
    expect(expandEvents(event, [], app.moduleContext)).toEqual([event]);
  });

  it("module_list_comes_from_generated_file", () => {
    expect(
      apiModulesFrom([
        { id: "x", module: {} },
        { id: "y", module: { apiModule: example } },
      ]),
    ).toEqual([example]);
    expect(apiModulesFrom(enabledModules).length).toBeLessThanOrEqual(enabledModules.length);
  });

  it("module_store_memory_and_sqlite_agree", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-"));
    try {
      const sqlite = createSqliteStores(join(dir, "api.sqlite"));
      for (const docs of [
        createMemoryModuleStore(),
        sqlite.docs,
        createSqliteModuleStore(new DatabaseSync(":memory:")),
      ]) {
        expect(docs.insert("links", "b", { n: 2 }, "acme.near")).toBe(true);
        expect(docs.insert("links", "b", { n: 9 }, "acme.near")).toBe(false);
        docs.put("links", "a", { n: 1 }, "other.near");
        docs.put("rate", "a", { n: 3 });
        expect(docs.get("links", "b")).toEqual({ n: 2 });
        expect(docs.list("links")).toEqual([{ n: 1 }, { n: 2 }]);
        expect(docs.list("links", "acme.near")).toEqual([{ n: 2 }]);
        docs.delete("links", "b");
        expect(docs.get("links", "b")).toBeUndefined();
      }
      sqlite.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("module events in the webhook worker", () => {
  it("module_events_delivered_to_subscribed_endpoints", async () => {
    const app = new ApiApp(deps([example]));
    app.store.saveWebhookEndpoint("acme.near", {
      id: "we_1",
      url: "https://hooks.example/x",
      secret: "whsec_test",
      events: ["example.thing"],
      created_at: "2026-01-01T00:00:00Z",
    });
    const sent: string[] = [];
    const worker = new WebhookWorker({
      store: app.store,
      events: {
        listEvents: async () => ({
          data: [{ id: "7", type: "thing", created: 1_794_000_000, data: {} }],
          next_cursor: "7",
        }),
      },
      fetchImpl: async (_url, init) => {
        sent.push(String(init?.body));
        return new Response("ok", { status: 200 });
      },
      validateUrl: async () => undefined,
      expand: (event) => expandEvents(event, app.modules, app.moduleContext),
    });
    await worker.runOnce();
    expect(sent.map((body) => (JSON.parse(body) as { id: string }).id)).toEqual(["7:example"]);
  });
});

describe("a broken module cannot stop core events", () => {
  it("skips a module whose events hook throws and still returns the original event and the others", () => {
    const lines: string[] = [];
    const event = { id: "evt_1", type: "booked", created: 1 } as unknown as IndexedEvent;
    const bad: ApiModule = {
      id: "bad",
      events: () => {
        throw new Error("boom");
      },
    };
    const good: ApiModule = {
      id: "good",
      events: (e) => [{ ...e, id: "evt_1_derived" } as IndexedEvent],
    };
    const out = expandEvents(event, [bad, good], {} as ApiModuleContext, (l) => lines.push(l));
    expect(out.map((e) => e.id)).toEqual(["evt_1", "evt_1_derived"]);
    expect(lines.join("\n")).toContain("module bad events hook failed: boom");
  });
});

describe("module quote window", () => {
  const claim = async () => ({
    token_id: "c-1",
    kind: 0,
    claim_account: "c-1.openrail.near",
    terms_hash: "0x" + "a".repeat(64),
    amount_due: "1000000",
    outstanding: "1000000",
    status: "Issued",
  });
  function windowHarness(window: ApiModule["quoteWindow"]) {
    const now = new Date("2026-11-10T10:00:00Z");
    const auth = new AuthStore(() => now.getTime());
    const { secret } = auth.createApiKey("acme.openrail.near", "k", "secret", ["invoices:read"]);
    const quote = vi.fn(async (request: { deadline: string; amount: string }) => ({
      quoteId: "q_1",
      depositAddress: "0xdeposit",
      deadline: request.deadline,
      amountIn: request.amount,
      amountOut: request.amount,
    }));
    const base = deps([{ id: "windowed", quoteWindow: window }]);
    const app = new ApiApp({
      ...base,
      auth,
      clock: () => now,
      contract: { claim, storageCredit: vi.fn() },
      quoteProvider: { quote },
    });
    const pay = (body: Record<string, unknown> = {}) =>
      app.handle({
        method: "POST",
        path: "/v1/pay/sessions",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${secret}` },
        body: { token_id: "c-1", route_id: "R1", refund_to: "0x" + "e".repeat(40), ...body },
      });
    return { pay, quote };
  }

  it("module_quote_window_caps_the_quote_deadline", async () => {
    const at = Math.floor(new Date("2026-11-10T10:05:00Z").getTime() / 1000);
    const { pay, quote } = windowHarness(async () => ({ notAfter: at }));
    expect((await pay()).status).toBe(201);
    expect(quote.mock.calls[0]?.[0].deadline).toBe("2026-11-10T10:05:00.000Z");
    // a payer cannot ask for a later deadline than the window
    expect((await pay({ deadline_seconds: 7200 })).status).toBe(201);
    expect(quote.mock.calls[1]?.[0].deadline).toBe("2026-11-10T10:05:00.000Z");
    // a shorter ask is honoured
    expect((await pay({ deadline_seconds: 60 })).status).toBe(201);
    expect(quote.mock.calls[2]?.[0].deadline).toBe("2026-11-10T10:01:00.000Z");
  });

  it("module_quote_window_closed_refuses_without_asking_the_provider", async () => {
    const at = Math.floor(new Date("2026-11-10T10:00:00Z").getTime() / 1000);
    const { pay, quote } = windowHarness(async () => ({ notAfter: at }));
    const response = await pay();
    expect(response.status).toBe(409);
    expect(quote).not.toHaveBeenCalled();
  });

  it("module_quote_window_may_refuse_with_its_own_error", async () => {
    const { pay, quote } = windowHarness(async () => {
      throw new ApiError(409, "closed_by_module");
    });
    const response = await pay();
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe("closed_by_module");
    expect(quote).not.toHaveBeenCalled();
  });

  it("module_without_a_window_leaves_quotes_alone", async () => {
    const { pay, quote } = windowHarness(async () => undefined);
    expect((await pay()).status).toBe(201);
    expect(quote).toHaveBeenCalledTimes(1);
  });
});
