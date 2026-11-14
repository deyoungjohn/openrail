import { describe, it, expect } from "vitest";
import {
  createMcpServer,
  createFakeApiClient,
  createHttpApiClient,
  mcpModulesFrom,
  type McpToolDefinition,
} from "./index.js";

describe("MCP Server Implementation (Cache, Rate Limit, JSON-RPC, HTTP Adapter)", () => {
  it("caches read-only tools for 30s and reports call counts in health()", async () => {
    let now = 1_000_000;
    let listCalls = 0;
    let statusCalls = 0;
    let quoteCalls = 0;

    const baseFake = createFakeApiClient();
    const api = {
      ...baseFake,
      listClaims: async (params?: Record<string, unknown>) => {
        listCalls += 1;
        return baseFake.listClaims!(params);
      },
      claimStatus: async (tokenId: string) => {
        statusCalls += 1;
        return baseFake.claimStatus!(tokenId);
      },
      quotePayLink: async (params: { tokenId: string; amountUsd?: string }) => {
        quoteCalls += 1;
        return baseFake.quotePayLink!(params);
      },
    };

    const server = createMcpServer({
      api,
      cacheTtlMs: 30_000,
      maxCallsPerMinute: 60,
      clock: () => now,
    });

    // First call hits the API
    const r1 = await server.callTool("list_claims", { status: "Open" });
    expect(r1.claims).toBeDefined();
    expect(listCalls).toBe(1);
    expect(server.health().api_calls_total).toBe(1);
    expect(server.health().cache_hits_total).toBe(0);

    // Second call 10s later reuses the 30s in-process cache
    now += 10_000;
    const r2 = await server.callTool("list_claims", { status: "Open" });
    expect(r2).toEqual(r1);
    expect(listCalls).toBe(1);
    expect(server.health().api_calls_total).toBe(1);
    expect(server.health().cache_hits_total).toBe(1);

    // Call with different arguments misses cache
    await server.callTool("list_claims", { status: "Paid" });
    expect(listCalls).toBe(2);

    // After 30s TTL expires, next call hits the API again
    now += 25_000; // 35s since first call
    await server.callTool("list_claims", { status: "Open" });
    expect(listCalls).toBe(3);

    // Non-read-only tool (quote_pay_link) is never cached
    await server.callTool("quote_pay_link", { tokenId: "c-1", amountUsd: "50.00" });
    await server.callTool("quote_pay_link", { tokenId: "c-1", amountUsd: "50.00" });
    expect(quoteCalls).toBe(2);

    // claim_status is cached for 30s
    await server.callTool("claim_status", { tokenId: "c-1" });
    await server.callTool("claim_status", { tokenId: "c-1" });
    expect(statusCalls).toBe(1);
  });

  it("enforces per-minute rate limit so an agent loop cannot flood the API", async () => {
    let now = 2_000_000;
    const api = createFakeApiClient();
    const server = createMcpServer({
      api,
      maxCallsPerMinute: 3,
      clock: () => now,
    });

    await server.callTool("claim_status", { tokenId: "c-1" });
    await server.callTool("claim_status", { tokenId: "c-1" });
    await server.callTool("claim_status", { tokenId: "c-1" });

    // 4th call within the same 60s window is rejected
    await expect(server.callTool("claim_status", { tokenId: "c-1" })).rejects.toThrow(
      /rate limit exceeded/i,
    );
    expect(server.health().rate_limited_total).toBe(1);

    // Advance clock past 60s window: calls succeed again
    now += 60_001;
    const res = await server.callTool("claim_status", { tokenId: "c-1" });
    expect(res.token_id).toBe("c-1");
  });

  it("handles JSON-RPC 2.0 and collects module tools via mcpModulesFrom with a real handler", async () => {
    const api = createFakeApiClient();
    const fakeModTools: McpToolDefinition[] = [
      {
        name: "fake_module_echo",
        description: "Fake enabled module tool with a real handler",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        handler: async (args) => ({ echoed: args.value }),
      },
    ];
    const moduleTools = mcpModulesFrom([
      { id: "fake_enabled", module: { mcpTools: fakeModTools } },
      { id: "empty_mod", module: {} },
    ]);

    const server = createMcpServer({
      api,
      enabledModules: ["fake_enabled"],
      moduleTools,
    });

    const initResp = await server.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(initResp?.result).toMatchObject({
      serverInfo: { name: "openrail-mcp" },
    });

    const listResp = await server.handleRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (listResp?.result as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(6); // 5 core + 1 fake module tool
    expect(tools.map((t) => t.name)).toContain("fake_module_echo");

    const modCallResp = await server.callTool("fake_module_echo", { value: "hello" });
    expect(modCallResp).toEqual({ echoed: "hello" });

    const callResp = await server.handleRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "prepare_invoice",
        arguments: { debtor: "bob.near", amountDue: "50000000" },
      },
    });
    expect(callResp?.error).toBeUndefined();
    const structured = (callResp?.result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(structured.human_signature_required).toBe(true);
    expect(structured.approval_url).toContain("https://");
  });

  it("adapts OpenrailClient HTTP endpoints: returns claim's own amount_due/pay_link or creates a pay session, and never signs", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: input,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (input.includes("/v1/invoices")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "inv_abc123",
                token_id: "c-1",
                invoice_number: "INV-001",
                amount_due: "50000000",
                amount_usd: "50.00",
                outstanding: "50000000",
                status: "Open",
                debtor_legal_name: "bob.near",
                due_date: "2026-11-01",
                pay_link: "https://openrail.incepture.dev/acme/inv/abc123",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (input.includes("/v1/pay/claims/c-1")) {
        return new Response(
          JSON.stringify({
            token_id: "c-1",
            invoice_number: "INV-001",
            amount_due: "50000000",
            amount_usd: "50.00",
            outstanding: "50000000",
            status: "Open",
            due_date: "2026-11-01",
            pay_link: "https://openrail.incepture.dev/acme/inv/abc123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (input.includes("/v1/pay/sessions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            id: "ps_1",
            token_id: "c-1",
            route_id: "base-usdc",
            quote_id: "q_123",
            deposit_address: "0x1111111111111111111111111111111111111111",
            deadline: "2026-11-12T00:00:00.000Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const httpApi = createHttpApiClient({
      baseUrl: "https://api.openrail.incepture.dev",
      webBaseUrl: "https://openrail.incepture.dev",
      fetchImpl,
    });
    const server = createMcpServer({ api: httpApi });

    const list = await server.callTool("list_claims", {});
    expect(list.claims).toHaveLength(1);
    expect(list.claims?.[0]?.id).toBe("c-1");

    // quote_pay_link without routeId/refundTo returns the claim's own pay link and recorded amount due (never echoing an unquoted caller amount)
    const payLinkRes = await server.callTool("quote_pay_link", {
      tokenId: "c-1",
      amountUsd: "999.99",
    });
    expect(payLinkRes.pay_url).toBe("https://openrail.incepture.dev/acme/inv/abc123");
    expect(payLinkRes.amount_due).toBe("50000000");
    expect(payLinkRes.amount_usd).toBe("50.00");

    // quote_pay_link with routeId and refundTo calls POST /v1/pay/sessions
    const quotedRes = await server.callTool("quote_pay_link", {
      tokenId: "c-1",
      amountUsd: "50.00",
      routeId: "base-usdc",
      refundTo: "0x2222222222222222222222222222222222222222",
    });
    expect(quotedRes.quote_id).toBe("q_123");
    expect(quotedRes.deposit_address).toBe("0x1111111111111111111111111111111111111111");

    const prepared = await server.callTool("prepare_invoice", {
      debtor: "bob.near",
      amountDue: "50000000",
    });
    expect(prepared.human_signature_required).toBe(true);
    expect(prepared.approval_url).toContain("https://openrail.incepture.dev/app/issue?");
    expect(prepared.unsigned_tx?.receiver_id).toBe("openrail.near");
    // Ensure prepare_invoice made zero POST requests to /v1/invoices
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/v1/invoices"))).toHaveLength(
      0,
    );
  });
});
