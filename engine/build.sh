#!/usr/bin/env bash
# Build the navigation core to WebAssembly and copy it where the site serves it.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown
mkdir -p ../public/engine
cp target/wasm32-unknown-unknown/release/nav_core.wasm ../public/engine/nav_core.wasm
ls -l ../public/engine/nav_core.wasm
