# Contributing to Splus

Thanks for helping make code review quieter. Splus is a deterministic Rust engine plus a thin
TypeScript layer (CLI + local MCP server). It runs entirely locally — there's no service to
stand up.

## Layout

- `crates/splus-engine/` — the deterministic engine (Rust). The source of truth for findings.
- `packages/shared/` — the canonical `Finding`/`Report` model (TS, mirrors the Rust serde model) + `runEngine`, which shells out to the engine binary.
- `packages/suppression/` — the learned per-repo noise filter (exact · rule · semantic).
- `packages/triage/` — the optional LLM layer, strictly downstream of the engine.
- `packages/cli/` — the `splus` CLI.
- `packages/mcp/` — the local stdio MCP server your agent connects to.
- `packages/landing/` — the splus.sh marketing site (also serves `install.sh`).

## Develop

```sh
cargo build --release        # engine → target/release/splus-engine
cargo test                   # engine tests
pnpm install
pnpm -r build                # build the TS packages
pnpm -r typecheck
node --test packages/suppression/dist/*.test.js packages/triage/dist/*.test.js   # unit tests
```

Point the TS surfaces at your freshly built engine:

```sh
export SPLUS_ENGINE=$PWD/target/release/splus-engine
node packages/cli/dist/index.js review --staged
```

The engine model (`crates/splus-engine/src/model.rs`) and the TS model
(`packages/shared/src/index.ts`) must stay in lockstep — change them together.

## Release

Tag a version and push:

```sh
git tag v0.3.1 && git push --tags
```

`.github/workflows/release.yml` cross-compiles the engine for macOS/Linux (arm64 + x64),
bundles the CLI + MCP server into single `.cjs` files (`scripts/build-release.mjs`), and
publishes a GitHub Release with per-platform tarballs + `SHA256SUMS`. `install.sh` pulls these
from the stable `releases/latest/download/splus-<os>-<arch>.tar.gz` URL.

## Principles

- **Deterministic first.** New rules belong in the engine with a reproducible anchor. The LLM
  layer only judges; it never free-scans.
- **Diff-scoped.** Only newly-added lines are ever flagged (clean-as-you-code).
- **Quiet by default.** A noisy comment costs more than a missed nit. When in doubt, suppress.
- **Local.** No network calls on the hot path; no telemetry.
