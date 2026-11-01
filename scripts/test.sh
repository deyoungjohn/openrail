#!/usr/bin/env bash
# Runs the Rust and TypeScript test suites.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --workspace
pnpm -r test
pnpm exec vitest run scripts
