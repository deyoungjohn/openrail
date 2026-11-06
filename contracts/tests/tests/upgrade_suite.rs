//! Upgrade sandbox suite verifying in-place contract upgrades from origin/main.
//!
//! Specifically validates:
//! 1. State written by the `origin/main` (d4bd298) contract is preserved across in-place upgrade.
//! 2. `Contract` struct Borsh layout compatibility: `claims`, `config`, `next_token_id`, `storage_credit`.
//! 3. Default raw storage resolution for Card A10 sponsor pool keys (pool: 0, cap: 5, used: 0).
//! 4. Full functionality of Card A10 methods (`deposit_sponsor_pool`, `set_sponsor_cap`, `withdraw_sponsor_pool`, `sponsor_status`, sponsored `issue_for`) after upgrade.

use anyhow::Result;
use near_sdk::json_types::U128;
use near_workspaces::types::NearToken;
use openrail::claims::REQUIRED_ISSUE_DEPOSIT;
use openrail::types::{ClaimView, Config, Debtor, Hex32, SponsorStatusView, Status, TokenMetadata};
use openrail_tests::Env;
use serde_json::json;

#[tokio::test]
async fn test_in_place_upgrade_from_main_preserves_state() -> Result<()> {
    // 1. Load origin/main wasm and current branch wasm
    let old_wasm =
        openrail_tests::wasms::openrail_origin_main_wasm().expect("load openrail_origin_main.wasm");
    let new_wasm = openrail_tests::wasms::openrail_wasm().expect("load openrail.wasm");

    // 2. Spin up sandbox with origin/main wasm
    let env = Env::new_with_root_wasm(&old_wasm).await?;

    // 3. Setup initial state on origin/main contract:
    // a) Deposit storage credit for Alice
    let credit_deposit = NearToken::from_millinear(100);
    env.alice
        .call(env.root.id(), "deposit_storage_credit")
        .deposit(credit_deposit)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let alice_credit_pre: U128 = env
        .root
        .view("storage_credit_of")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert_eq!(alice_credit_pre.0, credit_deposit.as_yoctonear());

    // b) Issue claim c-1
    let due_date = 1_850_000_000u64;
    let amount_due = 1_000_000u128;
    env.issue_claim(&env.alice, 0, amount_due, due_date)
        .await?
        .into_result()?;

    // c) Fund claim c-1 with 400_000 USDC and reconcile
    let funded_amount = 400_000u128;
    env.fund_claim("c-1", funded_amount, None)
        .await?
        .into_result()?;

    env.call_as(&env.watcher)
        .call_root(
            "reconcile",
            json!({ "token_id": "c-1" }),
            NearToken::from_yoctonear(0),
        )
        .await?
        .into_result()?;

    // Verify claim c-1 is PartiallyPaid before upgrade
    let pre_claim: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(pre_claim.status, Status::PartiallyPaid);
    assert_eq!(pre_claim.amount_due.0, amount_due);
    assert_eq!(pre_claim.booked_total.0, funded_amount);

    let pre_config: Config = env.root.view("config").args_json(json!({})).await?.json()?;

    // 4. Upgrade contract in-place
    env.root
        .as_account()
        .deploy(&new_wasm)
        .await?
        .into_result()?;

    // 5. Verify existing state is preserved identically under new wasm:
    // a) Claim c-1
    let post_claim: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    let post_claim = post_claim.expect("claim c-1 must exist after upgrade");
    assert_eq!(post_claim.token_id, "c-1");
    assert_eq!(post_claim.status, Status::PartiallyPaid);
    assert_eq!(post_claim.amount_due.0, amount_due);
    assert_eq!(post_claim.booked_total.0, funded_amount);
    assert_eq!(post_claim.due_date, due_date);
    assert_eq!(
        post_claim.debtor,
        Some(Debtor::Near(env.alice.id().clone()))
    );

    // b) Config
    let post_config: Config = env.root.view("config").args_json(json!({})).await?.json()?;
    assert_eq!(post_config, pre_config);

    // c) next_token_id view (new view in this branch; reads next_token_id from stored Contract)
    let next_id: u64 = env
        .root
        .view("next_token_id")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(next_id, 2, "next_token_id should be 2 after 1 issuance");

    // d) Storage credit of Alice
    let alice_credit_post: U128 = env
        .root
        .view("storage_credit_of")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert_eq!(alice_credit_post.0, credit_deposit.as_yoctonear());

    // e) Sponsor views default when keys absent (raw storage)
    let sponsor_alice: SponsorStatusView = env
        .root
        .view("sponsor_status")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert_eq!(sponsor_alice.pool.0, 0, "default sponsor pool must be 0");
    assert_eq!(sponsor_alice.cap, 5, "default sponsor cap must be 5");
    assert_eq!(sponsor_alice.used, 0, "default sponsored count must be 0");

    let sponsor_bob: SponsorStatusView = env
        .root
        .view("sponsor_status")
        .args_json(json!({ "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert_eq!(sponsor_bob.pool.0, 0);
    assert_eq!(sponsor_bob.cap, 5);
    assert_eq!(sponsor_bob.used, 0);

    // f) Settle & Payout module views default when state absent
    let held_c1_pre: Vec<serde_json::Value> = env
        .root
        .view("settle_held")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert!(held_c1_pre.is_empty(), "settle_held must default to empty");

    let settle_alice_pre: Option<serde_json::Value> = env
        .root
        .view("settlement_of")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert!(
        settle_alice_pre.is_none(),
        "settlement_of must default to None"
    );

    let relayers_pre: Vec<near_sdk::AccountId> = env
        .root
        .view("payout_relayers")
        .args_json(json!({}))
        .await?
        .json()?;
    assert!(
        relayers_pre.is_empty(),
        "payout_relayers must default to empty"
    );

    // 6. Test Card A10 operations on upgraded contract:
    // a) Deposit into sponsor pool
    let pool_deposit = NearToken::from_near(2);
    env.alice
        .call(env.root.id(), "deposit_sponsor_pool")
        .deposit(pool_deposit)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let sponsor_after_dep: SponsorStatusView = env
        .root
        .view("sponsor_status")
        .args_json(json!({ "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert_eq!(sponsor_after_dep.pool.0, pool_deposit.as_yoctonear());

    // b) Update sponsor cap via root
    env.root
        .as_account()
        .call(env.root.id(), "set_sponsor_cap")
        .args_json(json!({ "cap": 10 }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let sponsor_after_cap: SponsorStatusView = env
        .root
        .view("sponsor_status")
        .args_json(json!({ "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert_eq!(sponsor_after_cap.cap, 10);

    // c) Withdraw from sponsor pool: non-root fails, root succeeds
    let withdraw_fail = env
        .alice
        .call(env.root.id(), "withdraw_sponsor_pool")
        .args_json(json!({ "amount": U128(NearToken::from_near(1).as_yoctonear()) }))
        .max_gas()
        .transact()
        .await?;
    assert!(withdraw_fail.is_failure(), "non-root withdraw must fail");

    let withdraw_ok = env
        .root
        .as_account()
        .call(env.root.id(), "withdraw_sponsor_pool")
        .args_json(json!({ "amount": U128(NearToken::from_near(1).as_yoctonear()) }))
        .max_gas()
        .transact()
        .await?;
    assert!(withdraw_ok.is_success(), "root withdraw must succeed");

    let sponsor_after_withdraw: SponsorStatusView = env
        .root
        .view("sponsor_status")
        .args_json(json!({ "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert_eq!(
        sponsor_after_withdraw.pool.0,
        NearToken::from_near(1).as_yoctonear()
    );

    // d) Sponsored issue_for for Bob (0 personal storage credit, draws from pool)
    let bob_credit: U128 = env
        .root
        .view("storage_credit_of")
        .args_json(json!({ "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert_eq!(bob_credit.0, 0);

    env.issuer
        .call(env.root.id(), "issue_for")
        .args_json(json!({
            "business": env.bob.id(),
            "kind": 0,
            "debtor": Debtor::Near(env.bob.id().clone()),
            "terms_hash": Hex32::new([42u8; 32]),
            "amount_due": U128(500_000),
            "due_date": 1_900_000_000u64,
            "metadata": None::<TokenMetadata>,
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Bob now has 1 sponsored usage, pool decreased by REQUIRED_ISSUE_DEPOSIT
    let sponsor_bob_post: SponsorStatusView = env
        .root
        .view("sponsor_status")
        .args_json(json!({ "account_id": env.bob.id() }))
        .await?
        .json()?;
    assert_eq!(sponsor_bob_post.used, 1);
    assert_eq!(
        sponsor_bob_post.pool.0,
        NearToken::from_near(1).as_yoctonear() - REQUIRED_ISSUE_DEPOSIT.as_yoctonear()
    );

    // next_token_id is now 3
    let next_id_final: u64 = env
        .root
        .view("next_token_id")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(next_id_final, 3);

    // Claim c-2 exists and is in Issued status
    let c2_claim: Option<ClaimView> = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-2" }))
        .await?
        .json()?;
    assert!(c2_claim.is_some());
    assert_eq!(c2_claim.unwrap().status, Status::Issued);

    // 7. Test Settle & Payout module operations on upgraded contract:
    // a) Set payout relayers via root
    env.root
        .as_account()
        .call(env.root.id(), "set_payout_relayers")
        .args_json(json!({ "relayers": [env.watcher.id()] }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let relayers_post: Vec<near_sdk::AccountId> = env
        .root
        .view("payout_relayers")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(relayers_post, vec![env.watcher.id().clone()]);

    // b) Alice sets settlement destination
    env.alice
        .call(env.root.id(), "set_settlement")
        .args_json(json!({
            "chain": "base",
            "address": "0x1111111111111111111111111111111111111111",
            "min_amount": U128(100_000),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let settle_alice_post: Option<serde_json::Value> = env
        .root
        .view("settlement_of")
        .args_json(json!({ "account_id": env.alice.id() }))
        .await?
        .json()?;
    assert!(
        settle_alice_post.is_some(),
        "settlement_of must be configured"
    );

    // c) Fund remaining 600_000 USDC on c-1 (issued before upgrade) and reconcile
    env.fund_claim("c-1", 600_000, None).await?.into_result()?;

    env.call_as(&env.watcher)
        .call_root(
            "reconcile",
            json!({ "token_id": "c-1" }),
            NearToken::from_yoctonear(0),
        )
        .await?
        .into_result()?;

    let c1_final: ClaimView = env
        .root
        .view("claim")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(c1_final.status, Status::Paid);
    assert_eq!(c1_final.booked_total.0, 1_000_000);

    // Settle module held leg was recorded on the upgraded contract for c-1!
    let held_c1_post: Vec<serde_json::Value> = env
        .root
        .view("settle_held")
        .args_json(json!({ "token_id": "c-1" }))
        .await?
        .json()?;
    assert_eq!(held_c1_post.len(), 1, "must record held entry for c-1");
    assert_eq!(held_c1_post[0]["amount"], "598500");

    // d) Relayer executes payout on held entry
    let p_res = env
        .call_as(&env.watcher)
        .call_root(
            "settle_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "deposit_address": env.bob.id(),
                "amount_in": U128(598_500),
            }),
            NearToken::from_yoctonear(0),
        )
        .await?;
    assert!(p_res.is_success());
    let p_id: u64 = p_res.json()?;

    // e) Relayer reports payout settled
    let rep_res = env
        .call_as(&env.watcher)
        .call_root(
            "report_payout",
            json!({
                "token_id": "c-1",
                "index": 0,
                "payout_id": p_id,
                "outcome": {
                    "outcome": "settled",
                    "destination_tx": "0xupgrade_settled",
                },
            }),
            NearToken::from_yoctonear(0),
        )
        .await?;
    assert!(rep_res.is_success());

    Ok(())
}
