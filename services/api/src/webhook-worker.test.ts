import { describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "./stores.js";
import { WebhookWorker } from "./webhook-worker.js";

const endpoint = {
  id: "whe_1",
  url: "https://example.com/hook",
  secret: "whsec_test",
  events: ["booked"],
};

function harness(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  const store = createMemoryStores().api;
  store.saveWebhookEndpoint("acme.openrail.near", endpoint);
  let now = Date.parse("2026-11-02T10:00:00Z");
  const events = {
    listEvents: vi.fn(async () => ({
      data: [
        {
          id: "7",
          type: "booked",
          created: 1762077695,
          data: { token_id: "c-1", payment: "12500000" },
        },
      ],
      next_cursor: "7",
    })),
  };
  const worker = new WebhookWorker({
    events,
    store,
    fetchImpl,
    validateUrl: async () => undefined,
    clock: () => new Date(now),
    retryWindowMs: 24 * 60 * 60 * 1000,
  });
  return {
    store,
    events,
    worker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("webhook worker", () => {
  it("delivers once, retries a 500 with backoff, then stops", async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("fail", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const { store, events, worker, advance } = harness(fetchImpl);

    await worker.runOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.listDeliveries(endpoint.id)).toHaveLength(1);
    const [first] = fetchImpl.mock.calls;
    const headers = (first?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Openrail-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    advance(2000);
    await worker.runOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.listDeliveries(endpoint.id)).toHaveLength(2);

    await worker.runOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.listDeliveries(endpoint.id)).toHaveLength(2);
    expect(events.listEvents).toHaveBeenCalled();
  });

  it("carries storage_sponsored to a subscribed endpoint", async () => {
    const store = createMemoryStores().api;
    store.saveWebhookEndpoint("acme.openrail.near", {
      ...endpoint,
      events: ["storage_sponsored"],
    });
    const events = {
      listEvents: vi.fn(async () => ({
        data: [
          {
            id: "8",
            type: "storage_sponsored",
            created: 1762077695,
            data: { business: "acme.near", amount: "20000000000000000000000" },
          },
        ],
        next_cursor: "8",
      })),
    };
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 }),
    );
    const worker = new WebhookWorker({
      events,
      store,
      fetchImpl,
      validateUrl: async () => undefined,
      clock: () => new Date("2026-11-02T10:00:00Z"),
    });
    await worker.runOnce();
    expect(store.listDeliveries(endpoint.id)).toHaveLength(1);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ type: "storage_sponsored", data: { business: "acme.near" } });
  });

  it("keeps exactly one delivery per endpoint/event across a restart", async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 }),
    );
    const { store, events, worker } = harness(fetchImpl);
    await worker.runOnce();
    expect(store.listDeliveries(endpoint.id)).toHaveLength(1);

    const restarted = new WebhookWorker({
      events,
      store,
      fetchImpl,
      validateUrl: async () => undefined,
      clock: () => new Date("2026-11-02T10:05:00Z"),
    });
    await restarted.runOnce();
    expect(store.listDeliveries(endpoint.id)).toHaveLength(1);
    expect(store.getWorkerState("webhook_cursor")).toBe("7");
    expect(events.listEvents).toHaveBeenLastCalledWith(expect.objectContaining({ after: "7" }));
  });

  it("does not deliver history before an endpoint was created", async () => {
    const store = createMemoryStores().api;
    store.saveWebhookEndpoint("acme.openrail.near", {
      ...endpoint,
      created_at: "2026-11-02T10:00:00Z",
    });
    const events = {
      listEvents: vi.fn(async () => ({
        data: [
          {
            id: "old",
            type: "booked",
            created: Math.floor(Date.parse("2026-11-02T09:59:00Z") / 1000),
            data: {},
          },
          {
            id: "new",
            type: "booked",
            created: Math.floor(Date.parse("2026-11-02T10:01:00Z") / 1000),
            data: {},
          },
        ],
        next_cursor: "2",
      })),
    };
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("ok", { status: 200 }),
    );
    const worker = new WebhookWorker({
      events,
      store,
      fetchImpl,
      validateUrl: async () => undefined,
      clock: () => new Date("2026-11-02T10:05:00Z"),
    });
    await worker.runOnce();
    const deliveries = store.listDeliveries(endpoint.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.event_id).toBe("new");
    expect(store.getWorkerState("webhook_cursor")).toBe("2");
  });

  it("stops retrying after the 24 h window", async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("fail", { status: 503 }),
    );
    const { store, worker, advance } = harness(fetchImpl);
    await worker.runOnce();
    advance(25 * 60 * 60 * 1000);
    await worker.runOnce();
    const attempts = fetchImpl.mock.calls.length;
    await worker.runOnce();
    expect(fetchImpl.mock.calls.length).toBe(attempts);
    expect(store.outboxDue(Date.parse("2026-11-03T12:00:00Z"))).toHaveLength(0);
  });
});
