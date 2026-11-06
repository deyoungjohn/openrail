//! WASM artifact compilation, resolution, and caching for sandbox tests.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Resolve repository workspace root.
pub fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("canonical workspace root")
}

static OPENRAIL_WASM_CACHE: OnceLock<Vec<u8>> = OnceLock::new();
static VAULT_WASM_CACHE: OnceLock<Vec<u8>> = OnceLock::new();
static INTENTS_WASM_CACHE: OnceLock<Vec<u8>> = OnceLock::new();
static SIGNER_WASM_CACHE: OnceLock<Vec<u8>> = OnceLock::new();
static USDC_WASM_CACHE: OnceLock<Vec<u8>> = OnceLock::new();
static NFT_RECEIVER_WASM_CACHE: OnceLock<Vec<u8>> = OnceLock::new();
static OPENRAIL_ORIGIN_MAIN_WASM_CACHE: OnceLock<Vec<u8>> = OnceLock::new();

/// Compiles a crate into wasm32-unknown-unknown with `--cfg near`.
fn compile_wasm(
    manifest_path: &Path,
    target_subdir: &str,
    output_wasm_name: &str,
) -> Result<Vec<u8>> {
    let root = workspace_root();
    let target = root.join("target").join(target_subdir);

    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--manifest-path",
            manifest_path.to_str().expect("valid utf8 manifest path"),
        ])
        .env("CARGO_TARGET_DIR", &target)
        .env("RUSTFLAGS", "--cfg near")
        .status()
        .with_context(|| format!("cargo build for {}", manifest_path.display()))?;

    if !status.success() {
        return Err(anyhow!(
            "compilation failed for {}: exit status {}",
            manifest_path.display(),
            status
        ));
    }

    let wasm_file = target
        .join("wasm32-unknown-unknown/release")
        .join(output_wasm_name);
    std::fs::read(&wasm_file).with_context(|| format!("failed to read {}", wasm_file.display()))
}

/// Returns the real `openrail.wasm` root contract bytecode.
pub fn openrail_wasm() -> Result<Vec<u8>> {
    if let Some(cached) = OPENRAIL_WASM_CACHE.get() {
        return Ok(cached.clone());
    }

    if let Ok(path) = std::env::var("OPENRAIL_WASM") {
        let bytes = std::fs::read(&path).with_context(|| format!("read OPENRAIL_WASM={path}"))?;
        let _ = OPENRAIL_WASM_CACHE.set(bytes.clone());
        return Ok(bytes);
    }

    let root = workspace_root();
    let near_wasm = root.join("target/near/openrail/openrail.wasm");
    if near_wasm.exists() {
        let bytes = std::fs::read(&near_wasm)
            .with_context(|| format!("read cargo-near wasm {}", near_wasm.display()))?;
        let _ = OPENRAIL_WASM_CACHE.set(bytes.clone());
        return Ok(bytes);
    }

    // If not pre-built, build using scripts/contract.sh
    let contract_script = root.join("scripts/contract.sh");
    let status = if contract_script.exists() {
        let mut cmd = Command::new(&contract_script);
        if let Ok(home) = std::env::var("HOME") {
            let cargo_bin = format!("{home}/.cargo/bin");
            if let Ok(path) = std::env::var("PATH") {
                if !path.split(':').any(|p| p == cargo_bin) {
                    cmd.env("PATH", format!("{cargo_bin}:{path}"));
                }
            }
        }
        cmd.current_dir(&root)
            .status()
            .context("run scripts/contract.sh for openrail")?
    } else {
        let mut cmd = Command::new("cargo");
        if let Ok(home) = std::env::var("HOME") {
            let cargo_bin = format!("{home}/.cargo/bin");
            if let Ok(path) = std::env::var("PATH") {
                if !path.split(':').any(|p| p == cargo_bin) {
                    cmd.env("PATH", format!("{cargo_bin}:{path}"));
                }
            }
        }
        cmd.args([
            "near",
            "build",
            "non-reproducible-wasm",
            "--manifest-path",
            root.join("contracts/openrail/Cargo.toml")
                .to_str()
                .expect("manifest path"),
        ])
        .current_dir(&root)
        .status()
        .context("run cargo near build for openrail")?
    };

    if !status.success() {
        return Err(anyhow!("cargo near build failed: {status}"));
    }

    let bytes = std::fs::read(&near_wasm)
        .with_context(|| format!("read built wasm {}", near_wasm.display()))?;
    let _ = OPENRAIL_WASM_CACHE.set(bytes.clone());
    Ok(bytes)
}

/// Returns the `openrail_vault.wasm` contract bytecode.
pub fn vault_wasm() -> Result<Vec<u8>> {
    if let Some(cached) = VAULT_WASM_CACHE.get() {
        return Ok(cached.clone());
    }

    if let Ok(path) = std::env::var("VAULT_WASM") {
        let bytes = std::fs::read(&path).with_context(|| format!("read VAULT_WASM={path}"))?;
        let _ = VAULT_WASM_CACHE.set(bytes.clone());
        return Ok(bytes);
    }

    let root = workspace_root();
    let near_wasm = root.join("target/near/openrail_vault/openrail_vault.wasm");
    if near_wasm.exists() {
        let bytes = std::fs::read(&near_wasm)
            .with_context(|| format!("read vault wasm {}", near_wasm.display()))?;
        let _ = VAULT_WASM_CACHE.set(bytes.clone());
        return Ok(bytes);
    }

    let bytes = compile_wasm(
        &root.join("contracts/vault/Cargo.toml"),
        "sandbox-vault",
        "openrail_vault.wasm",
    )?;
    let _ = VAULT_WASM_CACHE.set(bytes.clone());
    Ok(bytes)
}

/// Returns the mock `intents.near` contract bytecode.
pub fn mock_intents_wasm() -> Result<Vec<u8>> {
    if let Some(cached) = INTENTS_WASM_CACHE.get() {
        return Ok(cached.clone());
    }

    let root = workspace_root();
    let bytes = compile_wasm(
        &root.join("contracts/mocks/intents/Cargo.toml"),
        "sandbox-mock-intents",
        "openrail_mock_intents.wasm",
    )?;
    let _ = INTENTS_WASM_CACHE.set(bytes.clone());
    Ok(bytes)
}

/// Returns the mock `v1.signer` contract bytecode.
pub fn mock_signer_wasm() -> Result<Vec<u8>> {
    if let Some(cached) = SIGNER_WASM_CACHE.get() {
        return Ok(cached.clone());
    }

    let root = workspace_root();
    let manifest = root.join("contracts/mocks/signer/Cargo.toml");
    if !manifest.exists() {
        return Err(anyhow!(
            "Cannot find mock signer crate at {}",
            manifest.display()
        ));
    }

    let bytes = compile_wasm(
        &manifest,
        "sandbox-mock-signer",
        "openrail_mock_signer.wasm",
    )?;
    let _ = SIGNER_WASM_CACHE.set(bytes.clone());
    Ok(bytes)
}

/// Returns the mock USDC contract bytecode.
pub fn mock_usdc_wasm() -> Result<Vec<u8>> {
    if let Some(cached) = USDC_WASM_CACHE.get() {
        return Ok(cached.clone());
    }

    let root = workspace_root();
    let manifest = root.join("contracts/mocks/usdc/Cargo.toml");
    if !manifest.exists() {
        return Err(anyhow!(
            "Cannot find mock USDC crate at {}",
            manifest.display()
        ));
    }

    let bytes = compile_wasm(&manifest, "sandbox-mock-usdc", "openrail_mock_usdc.wasm")?;
    let _ = USDC_WASM_CACHE.set(bytes.clone());
    Ok(bytes)
}

/// Returns the sandbox-only NEP-171 re-transferring receiver bytecode.
pub fn mock_nft_receiver_wasm() -> Result<Vec<u8>> {
    if let Some(cached) = NFT_RECEIVER_WASM_CACHE.get() {
        return Ok(cached.clone());
    }

    let root = workspace_root();
    let bytes = compile_wasm(
        &root.join("contracts/mocks/nft_receiver/Cargo.toml"),
        "sandbox-mock-nft-receiver",
        "openrail_mock_nft_receiver.wasm",
    )?;
    let _ = NFT_RECEIVER_WASM_CACHE.set(bytes.clone());
    Ok(bytes)
}

/// Pinned commit of openrail contract as deployed on mainnet (4 Nov deploy plan).
pub const BASELINE_DEPLOYED_SHA: &str = "899ad5540d02db8e77c7a98ef1daa24e8df04ae5";

/// Returns the `openrail.wasm` root contract bytecode built from the pinned mainnet baseline (`899ad55`).
pub fn openrail_baseline_mainnet_wasm() -> Result<Vec<u8>> {
    if let Some(cached) = OPENRAIL_ORIGIN_MAIN_WASM_CACHE.get() {
        return Ok(cached.clone());
    }

    if let Ok(path) = std::env::var("OPENRAIL_BASELINE_WASM") {
        let bytes =
            std::fs::read(&path).with_context(|| format!("read OPENRAIL_BASELINE_WASM={path}"))?;
        let _ = OPENRAIL_ORIGIN_MAIN_WASM_CACHE.set(bytes.clone());
        return Ok(bytes);
    }

    let root = workspace_root();
    let cached_path = root.join("target/near/openrail_baseline_mainnet.wasm");
    if cached_path.exists() {
        let bytes = std::fs::read(&cached_path)
            .with_context(|| format!("read cached {}", cached_path.display()))?;
        let _ = OPENRAIL_ORIGIN_MAIN_WASM_CACHE.set(bytes.clone());
        return Ok(bytes);
    }

    // Build from pinned commit using git archive
    let build_dir = root.join("target/baseline_tree");
    std::fs::create_dir_all(&build_dir)?;
    let archive_output = Command::new("git")
        .args(["archive", BASELINE_DEPLOYED_SHA])
        .current_dir(&root)
        .output()
        .context("git archive baseline sha")?;
    if !archive_output.status.success() {
        return Err(anyhow!("git archive baseline failed: {archive_output:?}"));
    }
    use std::io::Write;
    let mut tar_child = Command::new("tar")
        .args(["-x", "-C", build_dir.to_str().unwrap()])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .context("tar -x -C build_dir")?;
    tar_child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&archive_output.stdout)?;
    let tar_status = tar_child.wait()?;
    if !tar_status.success() {
        return Err(anyhow!("tar unpack failed"));
    }

    let manifest = build_dir.join("contracts/openrail/Cargo.toml");
    let status = Command::new("cargo")
        .args([
            "near",
            "build",
            "non-reproducible-wasm",
            "--manifest-path",
            manifest.to_str().unwrap(),
            "--features",
            "standing,checkout,advance,proof,agent,shopify,subscriptions",
        ])
        .status()
        .context("cargo near build for baseline")?;
    if !status.success() {
        return Err(anyhow!("cargo near build failed for baseline"));
    }

    let built_wasm = build_dir.join("target/near/openrail/openrail.wasm");
    let bytes = std::fs::read(&built_wasm)?;
    let _ = std::fs::create_dir_all(root.join("target/near"));
    let _ = std::fs::write(&cached_path, &bytes);
    let _ = OPENRAIL_ORIGIN_MAIN_WASM_CACHE.set(bytes.clone());
    Ok(bytes)
}

/// Alias for `openrail_baseline_mainnet_wasm()`.
pub fn openrail_origin_main_wasm() -> Result<Vec<u8>> {
    openrail_baseline_mainnet_wasm()
}
