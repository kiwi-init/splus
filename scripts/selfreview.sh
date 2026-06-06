#!/usr/bin/env bash
#
# Run Splus on its own code, locally — the deterministic engine, no agent needed.
#
#   bash scripts/selfreview.sh                 # review the ENTIRE repo (default)
#   bash scripts/selfreview.sh --staged        # just staged changes
#   bash scripts/selfreview.sh --base main     # PR-style, vs a base ref
#
# This is the deterministic tier only — the same grounded findings your agent
# gets over MCP, before it layers on its own judgment and this repo's learned
# suppression. Read-only: it analyzes the diff and prints findings; the only
# thing it writes is the build artifact under target/ (gitignored).
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "▸ Building the engine (first run is slow; later runs are cached)…"
cargo build --release

ENGINE="$PWD/target/release/splus-engine"

# Default scope: the whole committed repository. Override by passing flags.
if [ "$#" -eq 0 ]; then set -- --all; fi

echo "▸ Reviewing: splus-engine review $*"
echo
"$ENGINE" review --root . "$@" --format pretty
