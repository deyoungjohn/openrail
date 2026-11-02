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
