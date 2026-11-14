# Tests and evidence

How Openrail is tested, how to run the tests, and where the measured runs behind each number live.

## Run the tests

```bash Shell
make test          # contract unit, model and sandbox suites, then every service
pnpm test          # the TypeScript packages and services
make lint          # rustfmt, clippy, eslint, prettier
make leak-check    # no trace of switched-off modules (needs LEAK_KEYWORDS_FILE)
make secret-scan   # no secrets in the tree
```

The web app also has Playwright suites: `pnpm --filter @openrail/web test:e2e:web` (screens, states, accessibility, light and dark, 360 px) and `test:e2e:stack` (the full stack on a sandbox).

## What CI runs

Every pull request builds the contract, checks its wasm imports and ABI, runs the core tests, builds and tests **each module set** and **all modules on**, runs the web e2e suite, checks the deploy scripts and runs the secret scan, and runs the leak check whenever a keyword list of switched-off modules is configured. A merge needs all of them green.

## How tests are written

- From the spec, before the code they test, and by someone other than the code's author.
- Never weakened to make code pass; a disagreement with the spec is raised, not patched.
- Contract rules are **mutation-checked**: each rule was broken on purpose and a named test had to fail.

## Evidence

Each number in these docs comes from a run kept in `evidence/` or `reports/`:

| Claim                                                                       | Run                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| Median booking 30.5 s after the provider's success                          | K12, timed checkouts on mainnet                |
| Gas and storage at 1 and 5,000 claims                                       | Gate G1 scale suite (sandbox)                  |
| 0% spread on USDC to USDC routes                                            | K2′ route probe                                |
| ETH/SOL tolerance kept by the provider                                      | Pay report, 31 Oct                             |
| A per-invoice account with no access keys, the NFT in the business's wallet | K1, mainnet                                    |
| A transferred claim pays its new holder                                     | K13, mainnet                                   |
| The client's EIP-712 acknowledgement                                        | K14, mainnet, with a real OKX wallet signature |

The [Proof page](/proof) adds the live record: the demo business's real transactions on mainnet, with explorer links.
