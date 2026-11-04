#!/usr/bin/env bash
# Prints the human-run deploy plan. Read-only: nothing is signed or sent.
# Set SKIP_BUILD=1 to reuse an existing target/near/openrail/openrail.wasm.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "MISSING_DOCKER: cargo near build reproducible-wasm needs Docker" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "DOCKER_UNAVAILABLE: current user cannot reach the Docker daemon" >&2
    exit 1
  fi
  image="$(sed -n 's/^image = "\(.*\)"/\1/p' contracts/openrail/Cargo.toml | head -1)"
  digest="$(sed -n 's/^image_digest = "\(.*\)"/\1/p' contracts/openrail/Cargo.toml | head -1)"
  if [[ -z "$image" || -z "$digest" ]]; then
    echo "REPRODUCIBLE_IMAGE_UNPINNED: image or image_digest missing from contracts/openrail/Cargo.toml" >&2
    exit 1
  fi
  actual="$(docker manifest inspect --verbose "$image" 2>/dev/null | node -e '
    let body = "";
    process.stdin.on("data", (chunk) => (body += chunk));
    process.stdin.on("end", () => {
      try {
        process.stdout.write(JSON.parse(body).Descriptor.digest);
      } catch {
        process.exit(1);
      }
    });
  ')"
  if [[ -z "$actual" ]]; then
    echo "REPRODUCIBLE_IMAGE_UNVERIFIED: docker manifest inspect could not find $image" >&2
    exit 1
  fi
  if [[ "$actual" != "$digest" ]]; then
    echo "REPRODUCIBLE_IMAGE_MISMATCH: $image is $actual, pinned $digest" >&2
    exit 1
  fi
  if [[ -f .git ]]; then
    echo "LINKED_WORKTREE: run cargo near build reproducible-wasm from the primary checkout, not a linked worktree" >&2
    exit 1
  fi
  cargo near build reproducible-wasm --manifest-path contracts/openrail/Cargo.toml
fi

pnpm exec tsx scripts/deploy/plan.ts
