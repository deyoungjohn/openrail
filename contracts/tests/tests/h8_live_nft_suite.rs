//! Independent test suite for H8: Live Invoice NFT (Blueprint 4.5 H8 / REL-1 gate).
//!
//! Verifies:
//! 1. Live media changes with status across the full claim lifecycle:
//!    `Issued` -> `PartiallyPaid` -> `Paid` -> `Closed`, as well as `Cancelled`.
//! 2. Shows paid amount and percentage accurately.
//! 3. Flips to `Overdue` when block time passes `due_date` for open claims,
//!    and does not mark `Paid` claims as overdue.
//! 4. XML-escapes hostile invoice numbers / titles in the live rendered SVG.
//! 5. Live media is present and consistent on `nft_token`, `nft_tokens`, and `nft_tokens_for_owner`.
//! 6. Legacy claims minted before H8 (with stored media present in contract storage)
//!    render live media dynamically rather than returning the stale stored media.

use anyhow::{Context, Result};
use near_sdk::borsh::BorshDeserialize;
use openrail::svg::{decode_svg_data_uri, invoice_svg_live};
use openrail::types::{Claim, JsonToken, Status, TokenMetadata};
use openrail_tests::env::Env;
use serde_json::json;

/// Decodes an SVG data URI into UTF-8 text and verifies SVG envelope tags.
fn extract_svg(media_uri: &str) -> String {
    let prefix = "data:image/svg+xml;base64,";
    assert!(
        media_uri.starts_with(prefix),
        "Media must start with '{prefix}', got: {media_uri}"
    );
    let svg = decode_svg_data_uri(media_uri).expect("media must be valid base64-encoded SVG");
    assert!(
        svg.starts_with("<svg") && svg.ends_with("</svg>"),
        "Decoded content must be an SVG element: {svg}"
    );
    svg
}

/// 1. Media changes with status across Issued, PartiallyPaid, Paid, Closed, and Cancelled,
/// and accurately reflects amount paid and percent.
#[tokio::test]
async fn test_h8_media_changes_with_all_statuses_and_shows_amount_percent() -> Result<()> {
    let env = Env::new().await?;

    // --- Part A: Issued -> PartiallyPaid -> Paid -> Closed ---
    // Issue a claim for $10.00 (10_000_000 micro-USD), due in the future
    let issue_res = env
        .issue_claim(&env.alice, 0, 10_000_000, 2_000_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    // Status: Issued (0% paid)
    let token_issued: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let meta_issued = token_issued
        .context("token must exist")?
        .metadata
        .context("metadata must exist")?;
    let svg_issued = extract_svg(&meta_issued.media.context("media must be present")?);

    assert!(
        svg_issued.contains("Status: Issued"),
        "SVG must show Status: Issued, got: {svg_issued}"
    );
    assert!(
        svg_issued.contains("Paid: $0.00 (0%)"),
        "SVG must show Paid: $0.00 (0%), got: {svg_issued}"
    );
    assert!(
        svg_issued.contains(">$10.00</text>"),
        "SVG must display total amount $10.00, got: {svg_issued}"
    );
    assert!(
        !svg_issued.contains("Overdue"),
        "Future due date must not show Overdue in Issued state"
    );

    // Fund $2.50 (2_500_000 micro-USD) -> 25% payment
    let _ = env.fund_claim(&token_id, 2_500_000, None).await?;
    let rec1 = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec1.is_success());

    // Status: PartiallyPaid (25% paid)
    let token_partial: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let svg_partial = extract_svg(
        &token_partial
            .unwrap()
            .metadata
            .unwrap()
            .media
            .context("media must exist")?,
    );

    assert!(
        svg_partial.contains("Status: PartiallyPaid"),
        "SVG must show Status: PartiallyPaid, got: {svg_partial}"
    );
    assert!(
        svg_partial.contains("Paid: $2.50 (25%)"),
        "SVG must show Paid: $2.50 (25%), got: {svg_partial}"
    );

    // Fund remaining $7.50 (7_500_000 micro-USD) -> 100% payment
    let _ = env.fund_claim(&token_id, 7_500_000, None).await?;
    let rec2 = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec2.is_success());

    // Status: Paid (100% paid)
    let token_paid: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let svg_paid = extract_svg(
        &token_paid
            .unwrap()
            .metadata
            .unwrap()
            .media
            .context("media must exist")?,
    );

    assert!(
        svg_paid.contains("Status: Paid"),
        "SVG must show Status: Paid, got: {svg_paid}"
    );
    assert!(
        svg_paid.contains("Paid: $10.00 (100%)"),
        "SVG must show Paid: $10.00 (100%), got: {svg_paid}"
    );
    assert!(
        !svg_paid.contains("Overdue"),
        "Paid claim must not show Overdue"
    );

    // Close the Paid claim
    let close_res = env
        .alice
        .call(env.root.id(), "close")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(close_res.is_success());

    // Status: Closed (from Paid)
    let token_closed: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let svg_closed = extract_svg(
        &token_closed
            .unwrap()
            .metadata
            .unwrap()
            .media
            .context("media must exist")?,
    );

    assert!(
        svg_closed.contains("Status: Closed"),
        "SVG must show Status: Closed, got: {svg_closed}"
    );
    assert!(
        svg_closed.contains("Paid: $10.00 (100%)"),
        "Closed paid claim must preserve 100% paid indicator"
    );

    // --- Part B: Issued -> Cancelled ---
    let issue_cancel = env
        .issue_claim(&env.alice, 0, 5_000_000, 2_000_000_000)
        .await?;
    let token_id_cancel: String = issue_cancel.json()?;

    let cancel_res = env
        .alice
        .call(env.root.id(), "cancel")
        .args_json(json!({ "token_id": token_id_cancel }))
        .max_gas()
        .transact()
        .await?;
    assert!(cancel_res.is_success());

    // Status: Cancelled
    let token_cancelled: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_id_cancel }))
        .await?
        .json()?;
    let svg_cancelled = extract_svg(
        &token_cancelled
            .unwrap()
            .metadata
            .unwrap()
            .media
            .context("media must exist")?,
    );

    assert!(
        svg_cancelled.contains("Status: Cancelled"),
        "SVG must show Status: Cancelled, got: {svg_cancelled}"
    );
    assert!(
        svg_cancelled.contains("Paid: $0.00 (0%)"),
        "Cancelled claim must show Paid: $0.00 (0%)"
    );

    Ok(())
}

/// 2. Media flips to Overdue when block time passes due date on open claims,
/// and does not flip to Overdue when claim is Paid.
#[tokio::test]
async fn test_h8_media_flips_to_overdue_when_block_time_passes_due_date() -> Result<()> {
    let env = Env::new().await?;

    // Claim A: due date in the past (100_000 = Jan 1970).
    // Current sandbox block timestamp is > 1_700_000_000 seconds.
    let issue_past = env.issue_claim(&env.alice, 0, 4_000_000, 100_000).await?;
    let token_past: String = issue_past.json()?;

    // Issued state with past due date -> must be marked Overdue
    let token_overdue: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_past }))
        .await?
        .json()?;
    let svg_overdue = extract_svg(
        &token_overdue
            .unwrap()
            .metadata
            .unwrap()
            .media
            .context("media must exist")?,
    );

    assert!(
        svg_overdue.contains("Overdue"),
        "Open claim with past due date must contain 'Overdue', got: {svg_overdue}"
    );
    assert!(
        svg_overdue.contains("1970-01-02"),
        "Overdue text must mention formatted due date, got: {svg_overdue}"
    );

    // PartiallyPaid state with past due date -> must still be marked Overdue
    let _ = env.fund_claim(&token_past, 1_000_000, None).await?;
    let rec_partial = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_past }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_partial.is_success());

    let token_partial_overdue: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_past }))
        .await?
        .json()?;
    let svg_partial_overdue = extract_svg(
        &token_partial_overdue
            .unwrap()
            .metadata
            .unwrap()
            .media
            .context("media must exist")?,
    );

    assert!(
        svg_partial_overdue.contains("Status: PartiallyPaid"),
        "Status must be PartiallyPaid"
    );
    assert!(
        svg_partial_overdue.contains("Overdue"),
        "Partially paid claim with past due date must still be Overdue"
    );

    // Paid state with past due date -> must NOT show Overdue once fully paid
    let _ = env.fund_claim(&token_past, 3_000_000, None).await?;
    let rec_paid = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_past }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec_paid.is_success());

    let token_paid: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_past }))
        .await?
        .json()?;
    let svg_paid = extract_svg(
        &token_paid
            .unwrap()
            .metadata
            .unwrap()
            .media
            .context("media must exist")?,
    );

    assert!(
        svg_paid.contains("Status: Paid"),
        "Status must be Paid, got: {svg_paid}"
    );
    assert!(
        !svg_paid.contains("Overdue"),
        "Fully paid claim must NOT show Overdue even if past due date, got: {svg_paid}"
    );

    // Claim B: due date far in future (2_100_000_000 = year 2036) -> must show 'Due' and NOT 'Overdue'
    let issue_future = env
        .issue_claim(&env.alice, 0, 4_000_000, 2_100_000_000)
        .await?;
    let token_future: String = issue_future.json()?;

    let token_not_overdue: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_future }))
        .await?
        .json()?;
    let svg_not_overdue = extract_svg(
        &token_not_overdue
            .unwrap()
            .metadata
            .unwrap()
            .media
            .context("media must exist")?,
    );

    assert!(
        svg_not_overdue.contains("Due 2036-07-18"),
        "Future claim must display 'Due <date>', got: {svg_not_overdue}"
    );
    assert!(
        !svg_not_overdue.contains("Overdue"),
        "Future claim must not contain Overdue"
    );

    Ok(())
}

/// 3. Media is properly XML-escaped for hostile invoice numbers and titles.
#[tokio::test]
async fn test_h8_media_xml_escaped_hostile_invoice_number() -> Result<()> {
    let env = Env::new().await?;

    // 1. Direct unit verification on invoice_svg_live
    let hostile_invoice = "INV-<script>alert(\"evil\")&'";
    let escaped_svg = invoice_svg_live(
        hostile_invoice,
        5_000_000,
        1_000_000,
        &Status::PartiallyPaid,
        1_900_000_000,
        0,
    );

    assert!(
        !escaped_svg.contains("<script>"),
        "Raw <script> tag must not survive in live SVG: {escaped_svg}"
    );
    assert!(
        !escaped_svg.contains("</script>"),
        "Raw </script> tag must not survive in live SVG: {escaped_svg}"
    );
    assert!(
        escaped_svg.contains("&lt;script&gt;"),
        "Expected &lt;script&gt; in SVG: {escaped_svg}"
    );
    assert!(
        escaped_svg.contains("&quot;evil&quot;"),
        "Expected &quot;evil&quot; in SVG: {escaped_svg}"
    );
    assert!(
        escaped_svg.contains("&amp;"),
        "Expected &amp; in SVG: {escaped_svg}"
    );
    assert!(
        escaped_svg.contains("&apos;"),
        "Expected &apos; in SVG: {escaped_svg}"
    );

    // 2. Integration verification on the deployed contract:
    // Issue a claim, patch its claim record with hostile token_id, and verify nft_token escapes it
    let issue_res = env
        .issue_claim(&env.alice, 0, 5_000_000, 1_900_000_000)
        .await?;
    assert!(issue_res.is_success());
    let token_id: String = issue_res.json()?;

    let records = env.root.view_state().await?;
    let mut patched = false;
    let hostile_token = "c-<script>alert(\"x\")&'";

    for (k, v) in records {
        if let Ok(mut claim) = <Claim as BorshDeserialize>::try_from_slice(&v) {
            if claim.token_id == token_id {
                claim.token_id = hostile_token.to_string();
                let updated = near_sdk::borsh::to_vec(&claim)?;
                env.worker.patch_state(env.root.id(), &k, &updated).await?;
                patched = true;
                break;
            }
        }
    }
    assert!(patched, "Must patch claim state with hostile token_id");

    let token: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let media = token.unwrap().metadata.unwrap().media.unwrap();
    let svg = extract_svg(&media);

    assert!(
        !svg.contains("<script>"),
        "Contract live media must escape hostile script tags: {svg}"
    );
    assert!(
        svg.contains("&lt;script&gt;"),
        "Contract live media must contain escaped &lt;script&gt;: {svg}"
    );
    assert!(
        svg.contains("&amp;&apos;"),
        "Contract live media must contain escaped entities: {svg}"
    );

    Ok(())
}

/// 4. Live media is present and consistent on nft_token, nft_tokens, and nft_tokens_for_owner.
#[tokio::test]
async fn test_h8_media_present_across_nft_enumeration_endpoints() -> Result<()> {
    let env = Env::new().await?;

    // Issue claims for Alice and Bob
    let issue1 = env
        .issue_claim(&env.alice, 0, 1_000_000, 1_900_000_000)
        .await?;
    let token1: String = issue1.json()?;

    let issue2 = env
        .issue_claim(&env.bob, 0, 2_000_000, 1_900_000_000)
        .await?;
    let _token2: String = issue2.json()?;

    // Endpoint 1: nft_token
    let t1_view: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token1 }))
        .await?
        .json()?;
    let media1 = t1_view
        .context("token 1 must exist")?
        .metadata
        .context("metadata 1 must exist")?
        .media
        .context("media 1 must exist")?;
    let svg1 = extract_svg(&media1);
    assert!(svg1.contains("Status: Issued"));
    assert!(svg1.contains(">$1.00</text>"));

    // Endpoint 2: nft_tokens (paginated global enumeration)
    let all_tokens: Vec<JsonToken> = env
        .root
        .view("nft_tokens")
        .args_json(json!({ "from_index": "0", "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(all_tokens.len(), 2, "Expected 2 tokens in nft_tokens");

    for token in &all_tokens {
        let meta = token.metadata.as_ref().context("metadata required")?;
        let media = meta.media.as_ref().context("live media required")?;
        let svg = extract_svg(media);
        assert!(svg.contains("Status: Issued"));
        assert!(svg.contains("Paid: $0.00 (0%)"));
    }

    // Endpoint 3: nft_tokens_for_owner (paginated per-owner enumeration)
    let alice_tokens: Vec<JsonToken> = env
        .root
        .view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": env.alice.id(), "from_index": "0", "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(
        alice_tokens.len(),
        1,
        "Expected 1 token for Alice in nft_tokens_for_owner"
    );
    let alice_svg = extract_svg(
        alice_tokens[0]
            .metadata
            .as_ref()
            .unwrap()
            .media
            .as_ref()
            .unwrap(),
    );
    assert!(alice_svg.contains("Invoice 1"));
    assert!(alice_svg.contains(">$1.00</text>"));

    let bob_tokens: Vec<JsonToken> = env
        .root
        .view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": env.bob.id(), "from_index": "0", "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(
        bob_tokens.len(),
        1,
        "Expected 1 token for Bob in nft_tokens_for_owner"
    );
    let bob_svg = extract_svg(
        bob_tokens[0]
            .metadata
            .as_ref()
            .unwrap()
            .media
            .as_ref()
            .unwrap(),
    );
    assert!(bob_svg.contains("Invoice 2"));
    assert!(bob_svg.contains(">$2.00</text>"));

    Ok(())
}

/// 5. A claim minted before the change (stored media present in token_metadata KV record)
/// renders live media dynamically rather than returning the stale stored media.
#[tokio::test]
async fn test_h8_stored_media_from_mint_before_change_renders_live() -> Result<()> {
    let env = Env::new().await?;

    // Issue claim
    let issue_res = env
        .issue_claim(&env.alice, 0, 8_000_000, 2_000_000_000)
        .await?;
    let token_id: String = issue_res.json()?;

    // Simulate an older pre-H8 deployment where `issue` stored static SVG in `token_metadata`:
    // Find the state key for `token_metadata` and patch `media` to an old static string.
    let old_stale_media = "data:image/svg+xml;base64,T0xEX1NUQVRJQ19TVkdfRlJPTV9NElOVF9QUkUtSDg=";
    let records = env.root.view_state().await?;
    let mut patched = false;

    for (k, v) in records {
        if let Ok(mut meta) = <TokenMetadata as BorshDeserialize>::try_from_slice(&v) {
            if meta.title == Some("Invoice 1".to_string()) {
                meta.media = Some(old_stale_media.to_string());
                let updated = near_sdk::borsh::to_vec(&meta)?;
                env.worker.patch_state(env.root.id(), &k, &updated).await?;
                patched = true;
                break;
            }
        }
    }
    assert!(patched, "Must locate and patch token_metadata state record");

    // Verify raw storage now holds the stale media
    let mut raw_has_stale = false;
    for (_k, v) in env.root.view_state().await? {
        if let Ok(meta) = <TokenMetadata as BorshDeserialize>::try_from_slice(&v) {
            if meta.media.as_deref() == Some(old_stale_media) {
                raw_has_stale = true;
                break;
            }
        }
    }
    assert!(
        raw_has_stale,
        "Storage must confirm the injected stale media"
    );

    // Call nft_token: contract MUST NOT return the stale stored media!
    let token: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let current_media = token
        .context("token must exist")?
        .metadata
        .context("metadata must exist")?
        .media
        .context("media must exist")?;

    assert_ne!(
        current_media, old_stale_media,
        "nft_token must NOT return the stored stale media; it must render live"
    );

    let svg_live = extract_svg(&current_media);
    assert!(
        svg_live.contains("Status: Issued"),
        "Live rendered SVG must show current status Issued, got: {svg_live}"
    );
    assert!(
        svg_live.contains("Paid: $0.00 (0%)"),
        "Live rendered SVG must show Paid: $0.00 (0%), got: {svg_live}"
    );

    // Now advance claim state to PartiallyPaid and verify live rendering updates dynamically
    let _ = env.fund_claim(&token_id, 4_000_000, None).await?;
    let rec = env
        .alice
        .call(env.root.id(), "reconcile")
        .args_json(json!({ "token_id": token_id }))
        .max_gas()
        .transact()
        .await?;
    assert!(rec.is_success());

    let token_after_rec: Option<JsonToken> = env
        .root
        .view("nft_token")
        .args_json(json!({ "token_id": token_id }))
        .await?
        .json()?;
    let media_after_rec = token_after_rec
        .unwrap()
        .metadata
        .unwrap()
        .media
        .context("media must exist")?;

    assert_ne!(
        media_after_rec, old_stale_media,
        "media must not be stale after reconcile"
    );
    let svg_after_rec = extract_svg(&media_after_rec);
    assert!(
        svg_after_rec.contains("Status: PartiallyPaid"),
        "Live media must dynamically reflect PartiallyPaid"
    );
    assert!(
        svg_after_rec.contains("Paid: $4.00 (50%)"),
        "Live media must dynamically reflect Paid: $4.00 (50%)"
    );

    // Also verify enumeration endpoints override stored media with live media
    let all_tokens: Vec<JsonToken> = env
        .root
        .view("nft_tokens")
        .args_json(json!({ "from_index": "0", "limit": 10 }))
        .await?
        .json()?;
    let enum_media = all_tokens[0]
        .metadata
        .as_ref()
        .unwrap()
        .media
        .as_ref()
        .unwrap();
    assert_ne!(
        enum_media, &old_stale_media,
        "nft_tokens must override stored media with live rendered media"
    );

    let owner_tokens: Vec<JsonToken> = env
        .root
        .view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": env.alice.id(), "from_index": "0", "limit": 10 }))
        .await?
        .json()?;
    let owner_media = owner_tokens[0]
        .metadata
        .as_ref()
        .unwrap()
        .media
        .as_ref()
        .unwrap();
    assert_ne!(
        owner_media, &old_stale_media,
        "nft_tokens_for_owner must override stored media with live rendered media"
    );

    Ok(())
}
