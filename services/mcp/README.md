# Openrail MCP Server (`services/mcp`)

Agent interface for Openrail: exposes Model Context Protocol (MCP) tools for an AI agent to interact with Openrail without holding private keys or signing transactions.

## Core Tools

- `list_claims`: List or filter claims (`status`, `limit`).
- `claim_status`: Fetch current settlement and payment status of a specific claim (`tokenId`).
- `receipt`: Fetch payment receipt and proof of settlement (`tokenId`).
- `quote_pay_link`: Return the claim's hosted payment link and its recorded amount due (`tokenId`, `amountUsd`; or create a live 1Click quote session via `POST /v1/pay/sessions` when `routeId` and `refundTo` are supplied).
- `prepare_invoice`: Prepare an invoice creation transaction (`debtor`, `amountDue`, optional `dueDate`). Returns an unsigned transaction (`unsigned_tx`) and an approval link (`approval_url`) for the human to review and sign in their wallet.

Plus one tool per enabled module that exports `mcpTools` with a real handler via `src/enabled.ts` (for this build, none; switched-off modules are completely absent).

## Safety & Rate-Limit Invariants

1. **No keys, never signs**: The MCP server holds no private keys and never signs or broadcasts transactions. Any config containing a private key, secret key, signer, or seed phrase is immediately rejected. Every value-moving operation returns an unsigned payload (`unsigned_tx`) and `approval_url` with `human_signature_required: true`.
2. **In-process read cache & rate limit**: Read-only tools (`list_claims`, `claim_status`, `receipt`, and read-only module tools) reuse a 30-second in-process TTL cache (`cacheTtlMs: 30_000`) and enforce a per-minute invocation limit (`maxCallsPerMinute: 60`) so an agent loop cannot flood the API or strain RPC endpoints. Call and cache counters are exposed via `server.health()`.

## Example Usage (Runnable against the Fake API)

```typescript
import { createMcpServer, createFakeApiClient } from "@openrail/mcp";

const api = createFakeApiClient();
const server = createMcpServer({ api });

// List available tools
const tools = await server.listTools();
console.log("Tools:", tools.map((t) => t.name));

// 1. Check open claims and what client alice.near paid
const openClaims = await server.callTool("list_claims", { status: "Open" });
console.log("Open claims:", openClaims.claims);

const aliceStatus = await server.callTool("claim_status", { tokenId: "c-2" });
console.log("Claim c-2 status:", aliceStatus.status, "booked:", aliceStatus.booked_total);

// 2. Call quote_pay_link
const result = await server.callTool("quote_pay_link", {
  tokenId: "c-1",
  amountUsd: "50.00",
});
console.log("Pay link:", result.payUrl, "Amount due:", result.amount_usd);

// 3. Prepare an invoice for the human to sign in their wallet (never signs)
const prepared = await server.callTool("prepare_invoice", {
  debtor: "bob.near",
  amountDue: "100000000",
});
console.log("Approval link for human:", prepared.approval_url);
```

Run the example directly from the repository root:

```bash
pnpm --filter @openrail/mcp test
```

## Running the Stdio JSON-RPC Server

Against the fake API (no network or credentials required):

```bash
node services/mcp/bin/openrail-mcp.mjs --fake
```

Against a live or local Openrail API:

```bash
OPENRAIL_API_URL=https://openrail.incepture.dev OPENRAIL_API_KEY=<key> node services/mcp/bin/openrail-mcp.mjs
```
