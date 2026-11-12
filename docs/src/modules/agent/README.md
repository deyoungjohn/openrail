---
keywords: [MCP, agent tools, prepare invoice]
---

# Agent interface (MCP server)

Status: **built** on the private extras line; no mainnet run is needed beyond
reading existing G1 data. The package README has the runnable fake-API example.

`services/mcp` exposes Openrail to a user's own agent as tools that read and
prepare, never sign. The human approves every value-moving action in their wallet.

## Tools

Tool names come only from enabled parts:

- core: `list_claims`, `claim_status`, `receipt`, `quote_pay_link`,
  `prepare_invoice` (returns an unsigned transaction and a link for the human);
- one tool per enabled module that declares one.

The server holds no keys and never submits a transaction. The tool schema is the
contract; a tool that would move value returns a prepared action and a link
instead.

## Safety

- Every value-moving action is prepared for the human's wallet.
- Disabled modules contribute no tools, so the leak-check applies to tool names
  as well as routes.
- The MCP server reads the same public API; it does not get a privileged key.

## Not measured

There is no MCP latency, discovery-time or mainnet number yet. The planned tests
are `mcp_tools_schema_valid`, `mcp_no_value_without_human_signature`,
`mcp_tools_only_enabled` and `mcp_readme_example_runs`; they are not a measured
run, so no number is linked here. The blueprint has no Docs run for this module
beyond reading existing G1 data, so there is no command to copy.
