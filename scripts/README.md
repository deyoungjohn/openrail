# Scripts

`make <target>` runs `scripts/<target>.sh` and nothing else; fill in the script, never the Makefile.

| Script | Make target | Filled by |
|---|---|---|
| `contract.sh` | `contract` | P0.3 (builds with `cargo near build` for the enabled modules) |
| `test.sh` | `test` | P0.1 (`cargo test --workspace`, `pnpm -r test`) |
| `lint.sh` | `lint` | P0.1 (rustfmt, clippy `-D warnings`, eslint, prettier) |
| `secret-scan.sh` | `secret-scan` | P0.1 (`--self-test` runs the scanner's own tests) |
| `wasm-check.sh` | `wasm-check` | P0.4 |
| `leak-check.sh` | `leak-check` | P0.2 |
| `abi-check.sh` | `abi-check` | P0.2 |
| `docs.sh` | `docs` | P0.2 |
| `enabled-features` | none | P0.1 (prints the enabled module ids, comma-separated; `--all` lists every id) |

## CI Runner Modes

The GitHub Actions workflows (`ci.yml` and `nightly.yml`) are runner-agnostic and operate in two modes based on `vars.CI_RUNNER`:
1. **GitHub-Hosted (`ubuntu-latest`)**:
   - Default when `vars.CI_RUNNER` is unset or empty.
   - Installs native libraries (`libudev-dev`, `pkg-config`) via `sudo apt-get`.
   - Uses `Swatinem/rust-cache` and `actions/cache` for `cargo-near` binaries.
   - Uses default workspace `target/` directories.
2. **Self-Hosted (`["self-hosted", "openrail"]`)**:
   - Activated when `vars.CI_RUNNER` is configured to `["self-hosted","openrail"]`.
   - Runs as isolated user `ghrunner` (mode 750 protection from host user credentials; see `tools/setup-ci-runner.sh`).
   - Bypasses `sudo` steps and caching actions; all dependencies (rustup, cargo-near 0.22.0, node 22, pnpm) are pre-installed on the runner.
   - Isolates concurrent builds across jobs using `CARGO_TARGET_DIR=$HOME/target-ci/<job>`.
