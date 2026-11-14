# Modules

Openrail's core is invoices, payments and proof. Everything else is a module, and a module that is switched off is absent: not in the contract, the app, the CLI, the docs or the tests.

## In this build

| Module        | What it adds                                                                   |
| ------------- | ------------------------------------------------------------------------------ |
| `checkout`    | Hosted checkouts for stores, late-payment handling, payment links              |
| `settle`      | Payout destinations and schedules, the payout worker, the confidential balance |
| `shopify`     | The Shopify app and its connector service                                      |
| `woocommerce` | The WooCommerce plugin                                                         |
| `agent`       | The MCP server for AI agents                                                   |

The payout worker is a support service, started only when `checkout` and `settle` are on.

## How a module is switched

`openrail.modules.json` at the repository root decides. `pnpm gen:modules` writes the enabled list into each service and checks that every contract feature belongs to an enabled module.

```json openrail.modules.json
{
  "modules": [
    { "id": "checkout", "enabled": true },
    { "id": "agent", "enabled": true },
    { "id": "shopify", "enabled": true },
    { "id": "settle", "enabled": true },
    { "id": "woocommerce", "enabled": true }
  ]
}
```

## Hooks

The contract exposes a fixed hook interface (frozen early in the build) that modules plug into: credit checks at issue, the split of a booking, the rules for a kind of claim. Inert hooks are skipped, so a disabled module costs nothing at runtime. The API and the web app have the same idea: a module contributes routes, event names, settings sections and pages only when enabled.

## The leak check

CI builds every module set. Given a keyword list of switched-off modules, the leak check scans the wasm exports, the web bundle, the CLI help, the README and the generated docs. Any term of a switched-off module that appears fails the build.
