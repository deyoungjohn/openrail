# AI agents (MCP)

The Openrail MCP server lets an AI agent work with your invoices: check what was paid, fetch receipts, send pay links and prepare new invoices. It holds no keys and never signs: you approve anything that moves money.

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `list_claims` | `status?`, `limit?` | Your invoices and checkouts, filtered by status |
| `claim_status` | `tokenId` | What one invoice is owed, what is booked, whether it is settled |
| `receipt` | `tokenId` | The receipt and the proof of settlement |
| `quote_pay_link` | `tokenId`, `amountUsd`, optional `routeId` and `refundTo` | The pay link and amount due, or a live price for a coin and chain |
| `prepare_invoice` | `debtor`, `amountDue` (USDC base units), optional `dueDate` (Unix seconds) | An unsigned transaction and an approval link for you to sign |

Each enabled module can add its own tools; a module that is switched off adds none.

## Safety

- **No keys.** A configuration containing a private key, a seed phrase or a signer is refused at start.
- **Never signs, never sends.** Anything that moves value comes back as `unsigned_tx` with an `approval_url` and `human_signature_required: true`.
- **Same rules as the API.** It reads the public API with your API key and gets no special access.
- **Gentle on the network.** Reads are cached for 30 seconds and calls are limited to 60 a minute.

## Set it up

1. Create an API key in **API Integration**.
2. Get the server: clone the repository and install.

```bash Shell
git clone https://github.com/deyoungjohn/openrail.git
cd openrail && pnpm install
node services/mcp/bin/openrail-mcp.mjs --fake   # try it with sample data, no key
```

3. Add it to your MCP client (Claude Desktop, Claude Code or any other):

```json MCP client config
{
  "mcpServers": {
    "openrail": {
      "command": "node",
      "args": ["<path to openrail>/services/mcp/bin/openrail-mcp.mjs"],
      "env": {
        "OPENRAIL_API_URL": "https://api.openrail.incepture.dev",
        "OPENRAIL_API_KEY": "<an API key from API Integration>"
      }
    }
  }
}
```

## Things to ask

- "Which of my invoices are still open?" → `list_claims {"status":"Open"}`
- "Has c-12 been paid? How much is still owed?" → `claim_status {"tokenId":"c-12"}`
- "Get me the receipt for c-12." → `receipt {"tokenId":"c-12"}`
- "Send Spectra Inc the pay link for the $386.50 on c-14." → `quote_pay_link {"tokenId":"c-14","amountUsd":"386.50"}`
- "Bill northwind.near $250, due December 1." → `prepare_invoice {"debtor":"northwind.near","amountDue":"250000000","dueDate":1796083200}`

More on the [Agent MCP page](/agents).
