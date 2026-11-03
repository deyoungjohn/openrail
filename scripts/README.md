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
| `gate-run.sh` | none | P1.0 / I1 (nightly & gate runner: proptests 1,000, scale 5,000, mutation spot checks) |
| `enabled-features` | none | P0.1 (prints the enabled module ids, comma-separated; `--all` lists every id) |

## CI Runner

The GitHub Actions workflows (`ci.yml` and `nightly.yml`) run on GitHub-hosted `ubuntu-latest` runners:
- Uses `Swatinem/rust-cache` and `actions/cache` for `cargo-near` binaries.
- Sets `TMPDIR=$RUNNER_TEMP` on sandbox test jobs to avoid shared lockfile contention.
- Applies `CARGO_BUILD_JOBS=6`, `RUST_TEST_THREADS=4`, job timeouts, and sequential execution for heavy jobs.
