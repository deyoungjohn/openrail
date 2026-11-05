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
