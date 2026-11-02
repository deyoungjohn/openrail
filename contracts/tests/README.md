# Openrail Test Harness (`openrail-tests`)

Integration test harness and sandbox environment fixture for Openrail smart contracts.

## Overview

The `openrail-tests` crate provides the `Env` fixture for spinning up an isolated `near-workspaces` local sandbox, compiling and deploying the root `openrail` contract along with its companion contracts and sandbox mocks:
- `openrail.near`: Root contract initialized with Protocol `Config`.
- `intents.near`: Multi-token mock implementing `mt_balance_of`, `mt_batch_balance_of`, `mt_transfer`, `mt_transfer_call`, and `mt_mint`.
- `v1.signer`: MPC mock implementing K15 `sign(request)` and `signed_requests`.
- `usdc.near`: NEP-141 mock USDC token.
- Vault v2: Published as a global contract (Protocol 86); its code hash is populated in `Config.vault_code_hash`.
- Provisioned accounts: `fees`, `watcher`, `issuer`, `alice`, `bob`, `carol`.

## Serial Execution & Sandbox Concurrency

> [!IMPORTANT]
> Running multiple `near-workspaces` sandbox instances concurrently causes port collisions and high CPU contention on CI runners.
>
> `Env::new()` automatically acquires a global serial lock (`tokio::sync::Mutex`) that is held for the lifetime of the `Env` instance. When `env` is dropped at the end of each test, the lock is released for the next test. Always run tests using `cargo test -p openrail-tests -- --test-threads=1` or rely on the fixture's internal mutex.

## Worked Example

```rust
use anyhow::Result;
use openrail_tests::{Env, DEFAULT_SETTLEMENT_ASSET};
use near_sdk::json_types::U128;
use serde_json::json;

#[tokio::test]
async fn example_flow() -> Result<()> {
    // 1. Initialize environment (starts sandbox, deploys contracts & mocks)
    let env = Env::new().await?;

    // 2. Fund Alice's balance on intents.near
    env.intents
        .call("mt_mint")
        .args_json(json!({
            "account_id": env.alice.id(),
            "token_id": DEFAULT_SETTLEMENT_ASSET,
            "amount": U128(10_000_000),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // 3. Fund a claim vault sub-account
    env.fund_claim("c-1", 5_000_000, None).await?;
    let balance = env.claim_balance("c-1", None).await?;
    assert_eq!(balance, 5_000_000);

    // 4. Advance sandbox block height
    env.advance_blocks(10).await?;

    // 5. Interact with root contract as Alice
    let res = env.issue_claim(&env.alice, 0, 10_000_000, 1_700_000_000).await?;
    let gas = env.gas_report(&res);
    println!("{}", gas.summary());

    Ok(())
}
```

## Reconcile Gas Budget (Blueprint 2.5)

Calling `reconcile(token_id)` requires the caller to attach at least 250 Tgas (the watcher attaches 250 Tgas by default). This covers:
- `intents.near.mt_batch_balance_of`: 10 Tgas.
- `on_balances` callback: 220 Tgas, which performs balance delta arithmetic, anomaly detection, hook dispatching, up to 6 keyless vault forwards (`forward(token_id, amount, receiver_id, gas_tgas)` at 16 Tgas outer / 12 Tgas inner each), and `on_distributed` (10 Tgas).

## Running Tests

```bash
cargo test -p openrail-tests -- --test-threads=1
```
