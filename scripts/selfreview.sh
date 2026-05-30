#!/usr/bin/env bash
#
# Run Splus on its own code, locally — no GitHub Actions needed.
#
#   bash scripts/selfreview.sh                 # review the ENTIRE repo (default)
#   bash scripts/selfreview.sh --staged        # just staged changes
#   bash scripts/selfreview.sh --base main     # PR-style, vs a base ref
#   ANTHROPIC_API_KEY=sk-ant-... bash scripts/selfreview.sh   # + LLM triage
#
# This is read-only: it analyzes the diff and prints findings. The only things
# it writes are build artifacts and .splus-cache/ — all gitignored.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "▸ Building the engine + TS packages (first run is slow; later runs are cached)…"
cargo build --release
pnpm install --frozen-lockfile >/dev/null
pnpm -r build >/dev/null

export SPLUS_ENGINE="$PWD/target/release/splus-engine"
CLI=(node packages/cli/dist/index.js)

echo "▸ Generating a SCIP index for the precise blast-radius tier (best-effort)…"
"${CLI[@]}" index || echo "  (skipped — falling back to the heuristic tier)"

# Default scope: the whole committed repository. Override by passing flags.
if [ "$#" -eq 0 ]; then set -- --all; fi

FLAGS=()
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  FLAGS+=(--llm)
  echo "▸ LLM triage: ON"
else
  echo "▸ LLM triage: off (export ANTHROPIC_API_KEY to enable)"
fi

echo "▸ Reviewing: splus review $* ${FLAGS[*]}"
echo
"${CLI[@]}" review --root . "$@" "${FLAGS[@]}"
