import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth.js";
import { IdempotencyStore } from "./idempotency.js";
import { createSqliteStores } from "./stores.js";

const dirs: string[] = [];
function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "openrail-api-db-"));
  dirs.push(dir);
  return join(dir, "openrail.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const invoice = JSON.parse(
  readFileSync(new URL("../../../fixtures/api/invoices.create.json", import.meta.url), "utf8"),
) as unknown;

describe("SQLite stores", () => {
  it("survives a restart for keys, sessions, business, webhooks and invoices", async () => {
    const path = databasePath();
    const now = () => Date.parse("2026-11-02T10:00:00Z");
    const first = createSqliteStores(path);
    const auth = new AuthStore(now, 7 * 24 * 60 * 60 * 1000, first);
    const key = auth.createApiKey("acme.openrail.near", "Production");
    const challenge = auth.challenge("acme.openrail.near", "api.openrail.near");
    const session = await auth.verify(
      {
        accountId: "acme.openrail.near",
        publicKey: "ed25519:example",
        signature: "sig",
        nonce: challenge.nonce,
      },
      () => true,
      async () => true,
    );
    first.api.saveInvoice(invoice as never);
    first.api.saveBusiness({
      account_id: "acme.openrail.near",
      username: "acme",
      legal_name: "Acme Ltd",
      payout_account: "acme.payout.near",
      contact_email: "billing@example.com",
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    });
    first.api.saveWebhookEndpoint("acme.openrail.near", {
      id: "whe_1",
      url: "https://example.com/hook",
      secret: "whsec_example",
      events: ["invoice.paid"],
    });
    first.api.addDelivery("whe_1", { id: "whd_1", status_code: 200 });
    first.close?.();

    const second = createSqliteStores(path);
    const reopened = new AuthStore(now, 7 * 24 * 60 * 60 * 1000, second);
    expect(reopened.authenticate(key.secret).accountId).toBe("acme.openrail.near");
    expect(reopened.authenticate(session.sessionToken).kind).toBe("session");
    expect(second.api.getInvoice(String((invoice as { token_id: string }).token_id))).toBeDefined();
    expect(second.api.getBusiness("acme.openrail.near")?.legal_name).toBe("Acme Ltd");
    expect(second.api.getWebhookEndpoint("whe_1")?.url).toBe("https://example.com/hook");
    expect(second.api.listDeliveries("whe_1")).toHaveLength(1);
    second.close?.();
  });

  it("persists the webhook worker cursor", () => {
    const path = databasePath();
    const first = createSqliteStores(path);
    first.api.setWorkerState("webhook_cursor", "42");
    first.close?.();
    const second = createSqliteStores(path);
    expect(second.api.getWorkerState("webhook_cursor")).toBe("42");
    second.close?.();
  });

  it("expires idempotency entries after 24 h", () => {
    const path = databasePath();
    const stores = createSqliteStores(path);
    let now = Date.parse("2026-11-02T10:00:00Z");
    const idempotency = new IdempotencyStore(stores.idempotency, () => now);
    idempotency.put("key-1", { a: 1 }, { status: 201, body: { id: "inv_1" } });
    expect(idempotency.get("key-1", { a: 1 })?.status).toBe(201);
    now += 25 * 60 * 60 * 1000;
    expect(idempotency.get("key-1", { a: 1 })).toBeUndefined();
    stores.close?.();
  });
});
