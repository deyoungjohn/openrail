import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMockServer } from "@openrail/api";
import { runCli } from "./cli.js";

let server: Server;
let apiUrl: string;

beforeAll(async () => {
  server = createMockServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

beforeEach(() => {
  process.env.OPENRAIL_API_URL = apiUrl;
  process.env.OPENRAIL_API_KEY = "or_sk_live_cli_test_secret";
});

afterEach(() => {
  delete process.env.OPENRAIL_API_URL;
  delete process.env.OPENRAIL_API_KEY;
  delete process.env.NEAR_ACCOUNT_ID;
});

describe("openrail CLI", () => {
  it("routes --json returns the allow-listed routes", async () => {
    const result = await runCli(["routes", "--json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as { data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
  });

  it("invoices list --json returns a machine-stable page", async () => {
    const result = await runCli(["invoices", "list", "--json"]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as { data: { token_id: string }[] };
    expect(body.data[0]?.token_id).toBe("c-1");
  });

  it("defaults writes to dry-run and only sends with --execute", async () => {
    const dry = await runCli([
      "invoices",
      "create",
      "--json",
      "--data",
      JSON.stringify({ invoice_number: "INV-1" }),
    ]);
    expect(dry.exitCode).toBe(0);
    const dryBody = JSON.parse(dry.stdout) as {
      dry_run: boolean;
      request: { method: string; path: string };
    };
    expect(dryBody.dry_run).toBe(true);
    expect(dryBody.request).toMatchObject({ method: "POST", path: "/v1/invoices" });

    const live = await runCli([
      "invoices",
      "create",
      "--json",
      "--execute",
      "--data",
      JSON.stringify({
        invoice_number: "INV-1",
        issuer_legal_name: "Acme Ltd",
        debtor_legal_name: "Debtor Co",
        debtor_key: "debtor.openrail.near",
        amount_usd: "12.50",
        due_date: "2026-12-01",
        line_items: [{ description: "Design", quantity: 1, unit_amount_usd: "12.50" }],
      }),
    ]);
    expect(live.exitCode).toBe(0);
    const liveBody = JSON.parse(live.stdout) as { token_id: string };
    expect(liveBody.token_id).toBe("c-1");
  });

  it("never prints the env key", async () => {
    const result = await runCli(["routes", "--json"]);
    expect(result.stdout).not.toContain("or_sk_live_cli_test_secret");
    expect(result.stderr).not.toContain("or_sk_live_cli_test_secret");
  });

  it("requires OPENRAIL_API_URL and OPENRAIL_API_KEY with exit 2", async () => {
    delete process.env.OPENRAIL_API_KEY;
    const result = await runCli(["routes", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("MISSING_ENV: OPENRAIL_API_KEY");
  });

  it("maps API errors to exit 1 and a stable code", async () => {
    const result = await runCli(["payments", "get", "missing", "--json"], {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: "payment_not_found", message: "Payment not found" } }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
    });
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stderr) as {
      error: { code: string; details: { status: number } };
    };
    expect(body.error.code).toBe("API_ERROR");
    expect(body.error.details.status).toBe(404);
  });

  it("renders a human table without --json", async () => {
    const result = await runCli(["routes"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("origin_chain");
    expect(result.stdout).toContain("payer_asset");
  });

  it("prints the exact NEAR mt_transfer command for a cash-out quote", async () => {
    process.env.NEAR_ACCOUNT_ID = "acme.openrail.near";
    const result = await runCli([
      "cashout",
      "quote",
      "--json",
      "--amount",
      "2000000",
      "--destination-chain",
      "base",
      "--address",
      "0x" + "e".repeat(40),
    ]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as { near_cli: string; deposit_address: string };
    expect(body.near_cli).toContain("near call intents.near mt_transfer");
    expect(body.near_cli).toContain("--accountId acme.openrail.near");
  });

  it("supports --help and --version without env", async () => {
    delete process.env.OPENRAIL_API_URL;
    delete process.env.OPENRAIL_API_KEY;
    expect((await runCli(["--help"])).exitCode).toBe(0);
    expect((await runCli(["--version"])).stdout.trim()).toBe("0.1.0");
  });
});
