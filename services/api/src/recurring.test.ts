import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApiApp, type ApiDeps, type InvoiceRecord } from "./app.js";
import { AuthStore } from "./auth.js";
import {
  RecurringScheduler,
  issueAt,
  runDate,
  type RecurringTemplate,
  type RecurringView,
} from "./recurring.js";
import { createMemoryStores, createSqliteStores } from "./stores.js";
import { WebhookWorker } from "./webhook-worker.js";

const ACCOUNT = "acme.openrail.near";

function at(iso: string): () => Date {
  return () => new Date(iso);
}

function harness(now = "2026-11-05T10:00:00Z") {
  let current = new Date(now);
  const clock = () => current;
  const auth = new AuthStore(() => clock().getTime());
  const write = auth.createApiKey(ACCOUNT, "Production", "secret", [
    "invoices:read",
    "invoices:write",
  ]).secret;
  const readOnly = auth.createApiKey(ACCOUNT, "Read", "secret", ["invoices:read"]).secret;
  const otherSecret = auth.createApiKey("other.openrail.near", "Other", "secret", [
    "invoices:read",
    "invoices:write",
  ]).secret;
  let n = 0;
  const issuer = {
    prepareIssue: vi.fn(async () => {
      n += 1;
      return { tokenId: `c-${n}`, claimAccount: `c-${n}.openrail.near` };
    }),
    issueFor: vi.fn(async () => ({ txHash: "0xissue" })),
    logQuote: vi.fn(async () => ({ txHash: "0xquote" })),
    acknowledgeEvm: vi.fn(async () => ({ txHash: "0xack", ack: {} })),
  };
  const deps: ApiDeps = {
    config: {
      rootAccount: "openrail.near",
      recipient: "api.openrail.near",
      payBaseUrl: "https://pay.openrail.near",
    },
    auth,
    issuer,
    contract: {
      claim: vi.fn(async () => ({ kind: 0 })),
      storageCredit: vi.fn(async () => ({ balance: "0", amount: "0" })),
    },
    accessKey: { has: async () => true },
    verifier: () => true,
    cashout: { quote: async () => ({}) },
    clock,
  };
  const app = new ApiApp(deps);
  const send = vi.fn(async () => undefined);
  const scheduler = new RecurringScheduler({
    store: app.recurring,
    issue: (accountId, body, recurringId) => app.issueInvoice(accountId, body, { recurringId }),
    send,
    clock,
  });
  return {
    app,
    issuer,
    scheduler,
    send,
    write,
    readOnly,
    otherSecret,
    setNow(iso: string) {
      current = new Date(iso);
    },
  };
}

function req(
  method: string,
  path: string,
  body: unknown,
  secret: string,
  headers: Record<string, string> = {},
) {
  return {
    method,
    path,
    query: new URLSearchParams(),
    headers: { authorization: `Bearer ${secret}`, ...headers },
    body,
  };
}

const template = {
  repeat: "monthly",
  start_date: "2026-11-06",
  count: 3,
  send_email: false,
  email_to: null,
  due_days: 14,
  invoice: {
    invoice_number_prefix: "RET",
    issuer_legal_name: "Acme Ltd",
    debtor_legal_name: "Client Co",
    debtor_key: "client.near",
    amount_usd: "1500.00",
    line_items: [{ description: "Retainer", quantity: 1, unit_amount_usd: "1500.00" }],
  },
};

async function create(h: ReturnType<typeof harness>, body: unknown = template) {
  const response = await h.app.handle(req("POST", "/v1/recurring_invoices", body, h.write));
  return response as { status: number; body: RecurringView & { error?: { code: string } } };
}

describe("schedule dates", () => {
  const base = {
    start_date: "2026-01-31",
    repeat: "monthly",
  } as Pick<RecurringTemplate, "start_date" | "repeat">;

  it("recurring_monthly_clamps_to_month_end", () => {
    expect([0, 1, 2, 3].map((i) => runDate(base, i))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("recurring_weekly_and_quarterly_steps", () => {
    expect(runDate({ start_date: "2026-12-28", repeat: "weekly" }, 1)).toBe("2027-01-04");
    expect(runDate({ start_date: "2026-11-30", repeat: "quarterly" }, 1)).toBe("2027-02-28");
    expect(runDate({ start_date: "2026-11-30", repeat: "quarterly" }, 2)).toBe("2027-05-30");
  });

  it("recurring_issues_at_0600_utc", () => {
    expect(issueAt("2026-11-06").toISOString()).toBe("2026-11-06T06:00:00.000Z");
  });
});

describe("recurring API", () => {
  it("recurring_create_returns_template_with_next_run", async () => {
    const h = harness();
    const response = await create(h);
    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^rec_/);
    expect(response.body.status).toBe("active");
    expect(response.body.next_run_date).toBe("2026-11-06");
    expect(response.body.issued_count).toBe(0);
    expect(h.issuer.issueFor).not.toHaveBeenCalled();
  });

  it("recurring_validation_rejects_bad_input", async () => {
    const h = harness();
    const bad: Array<[string, unknown]> = [
      ["repeat", { ...template, repeat: "daily" }],
      ["start_date", { ...template, start_date: "2026-11-04" }],
      ["start_date", { ...template, start_date: "2026-02-30" }],
      ["end", { ...template, end_date: "2027-01-01" }],
      ["count", { ...template, count: 0 }],
      ["send_email", { ...template, send_email: true, email_to: "ap@client.example" }],
      ["amount_usd", { ...template, invoice: { ...template.invoice, amount_usd: "-1" } }],
      ["amount_usd", { ...template, invoice: { ...template.invoice, amount_usd: "1.005" } }],
      ["debtor_key", { ...template, invoice: { ...template.invoice, debtor_key: undefined } }],
      ["prefix", { ...template, invoice: { ...template.invoice, invoice_number_prefix: "a b" } }],
      ["end_date", { ...template, count: undefined, end_date: "2026-11-01" }],
    ];
    for (const [label, body] of bad) {
      const response = await create(h, body);
      expect(response.status, label).toBe(400);
      expect(response.body.error?.code, label).toBe("invalid_request");
    }
  });

  it("recurring_scopes_and_ownership", async () => {
    const h = harness();
    const denied = await h.app.handle(req("POST", "/v1/recurring_invoices", template, h.readOnly));
    expect(denied.status).toBe(403);
    const created = await create(h);
    const foreign = await h.app.handle(
      req("GET", `/v1/recurring_invoices/${created.body.id}`, undefined, h.otherSecret),
    );
    expect(foreign.status).toBe(404);
    const list = await h.app.handle(req("GET", "/v1/recurring_invoices", undefined, h.otherSecret));
    expect((list.body as { data: unknown[] }).data).toEqual([]);
  });

  it("recurring_create_is_idempotent_by_key", async () => {
    const h = harness();
    const headers = { "idempotency-key": "rec-key-0001" };
    const a = await h.app.handle(req("POST", "/v1/recurring_invoices", template, h.write, headers));
    const b = await h.app.handle(req("POST", "/v1/recurring_invoices", template, h.write, headers));
    expect((a.body as RecurringTemplate).id).toBe((b.body as RecurringTemplate).id);
    const list = await h.app.handle(req("GET", "/v1/recurring_invoices", undefined, h.write));
    expect((list.body as { data: unknown[] }).data).toHaveLength(1);
  });

  it("recurring_patch_pause_resume_cancel", async () => {
    const h = harness();
    const { body } = await create(h);
    const path = `/v1/recurring_invoices/${body.id}`;
    const paused = await h.app.handle(req("PATCH", path, { status: "paused" }, h.write));
    expect((paused.body as RecurringTemplate).status).toBe("paused");
    const amount = await h.app.handle(
      req("PATCH", path, { invoice: { amount_usd: "1600.00" } }, h.write),
    );
    expect((amount.body as RecurringTemplate).invoice.amount_usd).toBe("1600.00");
    const immutable = await h.app.handle(req("PATCH", path, { repeat: "weekly" }, h.write));
    expect(immutable.status).toBe(400);
    expect((immutable.body as { error: { code: string } }).error.code).toBe("immutable_field");
    const cancelled = await h.app.handle(req("PATCH", path, { status: "cancelled" }, h.write));
    expect((cancelled.body as RecurringTemplate).status).toBe("cancelled");
    const reopen = await h.app.handle(req("PATCH", path, { status: "active" }, h.write));
    expect(reopen.status).toBe(409);
  });
});

describe("recurring scheduler", () => {
  it("recurring_nothing_before_0600_on_the_date", async () => {
    const h = harness();
    await create(h);
    h.setNow("2026-11-06T05:59:59Z");
    await h.scheduler.runOnce();
    expect(h.issuer.issueFor).not.toHaveBeenCalled();
  });

  it("recurring_issues_through_issue_for_with_recurring_id", async () => {
    const h = harness();
    const { body } = await create(h);
    h.setNow("2026-11-06T06:00:30Z");
    await h.scheduler.runOnce();
    expect(h.issuer.issueFor).toHaveBeenCalledTimes(1);
    const invoices = h.app.store.listInvoices(ACCOUNT) as Array<
      InvoiceRecord & { recurring_id?: string }
    >;
    expect(invoices).toHaveLength(1);
    const invoice = invoices[0] as InvoiceRecord & { recurring_id?: string };
    expect(invoice.recurring_id).toBe(body.id);
    expect(invoice.invoice_number).toBe("RET-001");
    expect(invoice.amount_usd).toBe("1500.00");
    expect(invoice.due_date).toBe("2026-11-20");
    // Email is not available yet (see docs/internal): nothing is mailed.
    expect(h.send).not.toHaveBeenCalled();
    const view = await h.app.handle(
      req("GET", `/v1/recurring_invoices/${body.id}`, undefined, h.write),
    );
    const detail = view.body as RecurringView & { runs: Array<{ status: string }> };
    expect(detail.issued_count).toBe(1);
    expect(detail.next_run_date).toBe("2026-12-06");
    expect(detail.runs.map((run) => run.status)).toEqual(["issued"]);
  });

  it("recurring_issue_once_per_template_date", async () => {
    const h = harness();
    await create(h);
    h.setNow("2026-11-06T07:00:00Z");
    await Promise.all([h.scheduler.runOnce(), h.scheduler.runOnce()]);
    await h.scheduler.runOnce();
    expect(h.issuer.issueFor).toHaveBeenCalledTimes(1);
  });

  it("recurring_two_schedulers_share_the_store_once", async () => {
    const h = harness();
    await create(h);
    h.setNow("2026-11-06T07:00:00Z");
    const second = new RecurringScheduler({
      store: h.app.recurring,
      issue: (accountId, body, recurringId) => h.app.issueInvoice(accountId, body, { recurringId }),
      clock: at("2026-11-06T07:00:00Z"),
    });
    await Promise.all([h.scheduler.runOnce(), second.runOnce()]);
    expect(h.issuer.issueFor).toHaveBeenCalledTimes(1);
  });

  it("recurring_count_stops_and_completes", async () => {
    const h = harness();
    const { body } = await create(h);
    for (const day of ["2026-11-06", "2026-12-06", "2027-01-06", "2027-02-06"]) {
      h.setNow(`${day}T06:05:00Z`);
      await h.scheduler.runOnce();
    }
    expect(h.issuer.issueFor).toHaveBeenCalledTimes(3);
    const view = await h.app.handle(
      req("GET", `/v1/recurring_invoices/${body.id}`, undefined, h.write),
    );
    expect((view.body as RecurringTemplate).status).toBe("completed");
    expect((view.body as RecurringView).next_run_date).toBeNull();
  });

  it("recurring_end_date_inclusive", async () => {
    const h = harness();
    await create(h, { ...template, count: undefined, repeat: "weekly", end_date: "2026-11-20" });
    for (const day of ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]) {
      h.setNow(`${day}T06:05:00Z`);
      await h.scheduler.runOnce();
    }
    expect(h.issuer.issueFor).toHaveBeenCalledTimes(3);
  });

  it("recurring_paused_issues_nothing", async () => {
    const h = harness();
    const { body } = await create(h);
    await h.app.handle(
      req("PATCH", `/v1/recurring_invoices/${body.id}`, { status: "paused" }, h.write),
    );
    h.setNow("2026-11-06T06:05:00Z");
    await h.scheduler.runOnce();
    expect(h.issuer.issueFor).not.toHaveBeenCalled();
  });

  it("recurring_missed_beyond_grace_skipped_not_issued", async () => {
    const h = harness();
    const { body } = await create(h, { ...template, repeat: "weekly", count: 10 });
    h.setNow("2026-11-20T08:00:00Z");
    await h.scheduler.runOnce();
    // 6 Nov is 14 days late (skipped), 13 Nov is 7 days late (skipped), 20 Nov is today (issued)
    expect(h.issuer.issueFor).toHaveBeenCalledTimes(1);
    const view = await h.app.handle(
      req("GET", `/v1/recurring_invoices/${body.id}`, undefined, h.write),
    );
    const runs = (view.body as { runs: Array<{ run_date: string; status: string }> }).runs;
    expect(runs.map((run) => [run.run_date, run.status])).toEqual([
      ["2026-11-06", "skipped"],
      ["2026-11-13", "skipped"],
      ["2026-11-20", "issued"],
    ]);
  });

  it("recurring_failed_issue_retried_then_given_up", async () => {
    const h = harness();
    const { body } = await create(h);
    h.issuer.issueFor.mockRejectedValue(new Error("RPC down"));
    h.setNow("2026-11-06T06:05:00Z");
    await h.scheduler.runOnce();
    await h.scheduler.runOnce();
    await h.scheduler.runOnce();
    await h.scheduler.runOnce();
    expect(h.issuer.issueFor).toHaveBeenCalledTimes(3);
    const view = await h.app.handle(
      req("GET", `/v1/recurring_invoices/${body.id}`, undefined, h.write),
    );
    const detail = view.body as RecurringView & {
      runs: Array<{ status: string; attempts: number }>;
    };
    expect(detail.runs[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(detail.attention).toMatch(/2026-11-06/);
    expect(detail.next_run_date).toBe("2026-12-06");
  });

  it("recurring_crash_after_claim_not_reissued", async () => {
    const h = harness();
    const { body } = await create(h);
    // Simulate a process that claimed the run and died before recording the result.
    h.app.recurring.insertRun({
      template_id: body.id,
      run_date: "2026-11-06",
      status: "pending",
      attempts: 1,
      invoice_id: null,
      error: null,
      updated_at: "2026-11-06T06:00:01.000Z",
    });
    h.setNow("2026-11-06T06:30:00Z");
    await h.scheduler.runOnce();
    expect(h.issuer.issueFor).not.toHaveBeenCalled();
    const view = await h.app.handle(
      req("GET", `/v1/recurring_invoices/${body.id}`, undefined, h.write),
    );
    const detail = view.body as RecurringView & { runs: Array<{ status: string }> };
    expect(detail.runs[0]?.status).toBe("unknown");
    expect(detail.attention).toMatch(/check/i);
  });

  it("recurring_email_off_sends_nothing", async () => {
    const h = harness();
    await create(h, { ...template, send_email: false, email_to: undefined });
    h.setNow("2026-11-06T06:05:00Z");
    await h.scheduler.runOnce();
    expect(h.issuer.issueFor).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("recurring SQLite store", () => {
  it("recurring_sqlite_round_trip_and_unique_run", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    try {
      const stores = createSqliteStores(join(dir, "api.sqlite"));
      const memory = createMemoryStores();
      for (const store of [stores.recurring, memory.recurring]) {
        const record = {
          id: "rec_1",
          account_id: ACCOUNT,
          status: "active",
          repeat: "monthly",
          start_date: "2026-11-06",
          end_date: null,
          count: 2,
          due_days: 14,
          send_email: false,
          email_to: null,
          invoice: { ...template.invoice },
          next_index: 0,
          issued_count: 0,
          attention: null,
          created_at: "2026-11-05T10:00:00.000Z",
          updated_at: "2026-11-05T10:00:00.000Z",
        } as RecurringTemplate;
        store.save(record);
        expect(store.get("rec_1")).toEqual(record);
        expect(store.list(ACCOUNT)).toHaveLength(1);
        expect(store.list("x.near")).toHaveLength(0);
        const run = {
          template_id: "rec_1",
          run_date: "2026-11-06",
          status: "pending" as const,
          attempts: 1,
          invoice_id: null,
          error: null,
          updated_at: "2026-11-06T06:00:00.000Z",
        };
        expect(store.insertRun(run)).toBe(true);
        expect(store.insertRun(run)).toBe(false);
        store.updateRun({ ...run, status: "issued", invoice_id: "inv_1" });
        expect(store.listRuns("rec_1")).toEqual([
          { ...run, status: "issued", invoice_id: "inv_1" },
        ]);
      }
      stores.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("recurring events", () => {
  it("recurring_event_carries_recurring_id", async () => {
    const h = harness();
    const { body } = await create(h, { ...template, send_email: false, email_to: undefined });
    h.setNow("2026-11-06T06:05:00Z");
    await h.scheduler.runOnce();
    const invoice = h.app.store.listInvoices(ACCOUNT)[0] as InvoiceRecord;
    h.app.store.saveWebhookEndpoint(ACCOUNT, {
      id: "we_1",
      url: "https://hooks.example/openrail",
      secret: "whsec_test",
      events: ["claim_issued", "invoice.paid"],
      created_at: "2026-11-01T00:00:00Z",
    });
    const sent: string[] = [];
    const worker = new WebhookWorker({
      store: h.app.store,
      events: {
        listEvents: async () => ({
          data: [
            {
              id: "1",
              type: "claim_issued",
              created: 1_794_000_000,
              data: { token_id: invoice.token_id },
            },
            { id: "2", type: "invoice.paid", created: 1_794_000_000, data: { token_id: "c-99" } },
          ],
          next_cursor: "2",
        }),
      },
      fetchImpl: async (_url, init) => {
        sent.push(String(init?.body));
        return new Response("ok", { status: 200 });
      },
      validateUrl: async () => undefined,
      clock: () => new Date("2026-11-06T06:10:00Z"),
    });
    await worker.runOnce();
    const events = sent.map((raw) => JSON.parse(raw) as { data: Record<string, unknown> });
    expect(events[0]?.data.recurring_id).toBe(body.id);
    expect(events[1]?.data.recurring_id).toBeUndefined();
  });
});
