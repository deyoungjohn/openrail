# API fixtures

Recorded-shape examples for the S1a OpenAPI contract. `manifest.json` maps every
fixture to its operation, status and component schema; the contract test in
`services/api/src/contract.test.ts` validates each one against
`services/api/openapi.json`.

The mock server (`MOCK=1 pnpm --filter @openrail/api start`) serves the entries
marked `mock: true`. Error fixtures are contract-test only. Values are examples,
not live data; no real key or secret is present (`whsec_example_shown_once` is a
placeholder). Sources: blueprint 1.7, 2.6, 2.8, 2.9 and the recorded K2′/K8
provider shapes for `swap_details`.
