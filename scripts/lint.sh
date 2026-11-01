#!/usr/bin/env bash
# Lint everything: rustfmt check, clippy (-D warnings), eslint, prettier check.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
pnpm exec eslint .
pnpm exec prettier --check .
