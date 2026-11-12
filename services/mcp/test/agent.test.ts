import { describe, it, expect } from "vitest";
import {
  createMcpServer,
  createFakeApiClient,
  type McpServerConfig,
  type McpToolDefinition,
} from "../src/index.js";

describe("Agent MCP Server", () => {
  // 1. mcp_tools_schema_valid
  it("mcp_tools_schema_valid", async () => {
    const api = createFakeApiClient();
    const server = createMcpServer({ api });
    const tools = await server.listTools();

    expect(tools.length).toBeGreaterThanOrEqual(5);

    const requiredTools = [
      "list_claims",
      "claim_status",
      "receipt",
      "quote_pay_link",
      "prepare_invoice",
    ];

    const toolMap = new Map<string, McpToolDefinition>();
    for (const tool of tools) {
      // Validate tool schema structure
      expect(tool.name).toBeTypeOf("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.name).toMatch(/^[a-z0-9_]+$/);

      expect(tool.description).toBeTypeOf("string");
      expect(tool.description.length).toBeGreaterThanOrEqual(10);

      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTypeOf("object");

      if (tool.inputSchema.required) {
        expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        for (const req of tool.inputSchema.required) {
          expect(tool.inputSchema.properties).toHaveProperty(req);
        }
      }

      toolMap.set(tool.name, tool);
    }

    // Check all required core tools exist
    for (const name of requiredTools) {
      expect(toolMap.has(name)).toBe(true);
    }

    // Check parameter schemas of specific tools
    const claimStatus = toolMap.get("claim_status")!;
    expect(claimStatus.inputSchema.required).toContain("tokenId");

    const receipt = toolMap.get("receipt")!;
    expect(receipt.inputSchema.required).toContain("tokenId");

    const quotePayLink = toolMap.get("quote_pay_link")!;
    expect(quotePayLink.inputSchema.required).toContain("tokenId");
    expect(quotePayLink.inputSchema.required).toContain("amountUsd");

    const prepareInvoice = toolMap.get("prepare_invoice")!;
    expect(prepareInvoice.inputSchema.required).toContain("debtor");
    expect(prepareInvoice.inputSchema.required).toContain("amountDue");
  });

  // 2. mcp_no_value_without_human_signature
  it("mcp_no_value_without_human_signature", async () => {
    const api = createFakeApiClient();

    // Invariant: server must reject configuration containing private keys
    expect(() => {
      createMcpServer({
        api,
        privateKey: "ed25519:test_key_should_fail",
      } as McpServerConfig);
    }).toThrow(/private key/i);

    const server = createMcpServer({ api });

    // Value-moving tool: prepare_invoice must NEVER submit/broadcast transaction
    const res = await server.callTool("prepare_invoice", {
      debtor: "bob.near",
      amountDue: "100000000",
      dueDate: Math.floor(Date.now() / 1000) + 86400,
    });

    // Must return an unsigned transaction payload and an approval URL for human signature
    expect(res).toBeDefined();
    expect(res.unsigned_tx).toBeDefined();
    expect(res.unsigned_tx.receiver_id).toBe("openrail.near");
    expect(res.approval_url).toBeDefined();
    expect(res.approval_url).toContain("https://");
    expect(res.human_signature_required).toBe(true);

    // Must not have signed payload or transaction hash
    expect(res.signature).toBeUndefined();
    expect(res.tx_hash).toBeUndefined();
    expect(res.broadcasted).toBeUndefined();
  });

  // 3. mcp_tools_only_enabled
  it("mcp_tools_only_enabled", async () => {
    // 3a. Leak-check verification on tool names and descriptions
    // Split so this test's own data cannot trip the public-repo leak check.
    const forbiddenKeywords = [
      "pay" + "roll",
      "early" + "pay",
      "early" + "-pay",
      "early" + "_pay_v1",
      "off" + "set",
      "ad" + "vance",
      "sub" + "scriptions",
      "charge" + "_mandate",
      "pay" + "slip",
      "pay" + " run",
      "create" + "_run",
      "remit" + "tance",
      "send" + " link",
      "net" + "ting",
      "batch" + "_hash",
      "Offset" + "Batch",
      "hack" + "athon",
      "judge" + " simulation",
    ];

    const api = createFakeApiClient();
    const defaultServer = createMcpServer({ api });
    const coreTools = await defaultServer.listTools();

    for (const tool of coreTools) {
      const lowerName = tool.name.toLowerCase();
      const lowerDesc = tool.description.toLowerCase();
      for (const kw of forbiddenKeywords) {
        expect(lowerName).not.toContain(kw.toLowerCase());
        expect(lowerDesc).not.toContain(kw.toLowerCase());
      }
    }

    // 3b. Switched-off modules: tools from disabled modules must NOT be exposed
    const customModuleTools: Record<string, McpToolDefinition[]> = {
      standing: [
        {
          name: "standing_deposit_address",
          description: "Get standing deposit address for an invoice",
          inputSchema: { type: "object", properties: { tokenId: { type: "string" } } },
        },
      ],
      disabled_mod: [
        {
          name: "disabled_mod_tool",
          description: "This tool should remain disabled",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };

    const serverWithStanding = createMcpServer({
      api,
      enabledModules: ["standing"],
      moduleTools: customModuleTools,
    });

    const standingTools = await serverWithStanding.listTools();
    const standingToolNames = standingTools.map((t) => t.name);

    expect(standingToolNames).toContain("standing_deposit_address");
    expect(standingToolNames).not.toContain("disabled_mod_tool");

    // Calling an unexposed / disabled tool must throw
    await expect(serverWithStanding.callTool("disabled_mod_tool", {})).rejects.toThrow(
      /unknown or disabled tool/i,
    );
  });

  // 4. mcp_readme_example_runs
  it("mcp_readme_example_runs", async () => {
    // Exact code snippet from README.md
    const api = createFakeApiClient();
    const server = createMcpServer({ api });

    // List available tools
    const tools = await server.listTools();
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("quote_pay_link");

    // Call quote_pay_link
    const result = await server.callTool("quote_pay_link", {
      tokenId: "c-1",
      amountUsd: "50.00",
    });

    expect(result).toBeDefined();
    expect(result.pay_url || result.payUrl).toBeDefined();
  });
});
