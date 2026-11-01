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
