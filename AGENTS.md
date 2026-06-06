# Splus — agent instructions

Splus makes the coding agent in your editor a disciplined, precision-first code
reviewer: a deterministic Rust engine (the grounding) + a thin TS layer (MCP
server, memory) + the review protocol shipped as skills. 100% local.

## Layout

```
crates/splus-engine/   # deterministic engine (Rust) — the source of truth, zero inference
packages/
  shared/              # canonical Finding model (TS ↔ Rust serde lockstep) + runEngine/inspect
  suppression/         # per-repo memory — suppress (dismiss) + reinforce (accept)
  mcp/                 # the local stdio MCP server — the one and only usage path
skills/                # the review protocol (review, prefs) — installed per agent by install.sh
install.sh             # curl|sh installer: binaries → ~/.splus, wires MCP + skills into agents
```

## Build & test

```sh
cargo build --release        # engine → target/release/splus-engine
cargo test --locked          # engine tests
pnpm install
pnpm -r build && pnpm -r typecheck
pnpm -r test                 # unit tests (shared + suppression)
pnpm build:release           # bundle MCP server → dist-release/mcp.cjs
```

## Verification — non-negotiable

**Always run `greenrun` after code changes** — it executes the repo's GitHub
Actions locally and must PASS before work is called done or pushed:

```sh
greenrun --plain             # ~/.greenrun/bin/greenrun if not on PATH
```

Exit 0 = passed; treat anything else as a failure to fix, and never describe a
partial run as green.

## Conventions

- The Rust model (`crates/splus-engine/src/model.rs`) and the TS model
  (`packages/shared/src/index.ts`) stay in lockstep — change them together.
- Versions bump in lockstep across ALL `package.json` files + `Cargo.toml`
  (then `cargo build` to refresh `Cargo.lock`), with a `CHANGELOG.md` entry.
- The MCP server is agent-led by design: it grounds and directs, the session
  agent reasons. Never add a headless LLM path to it.
- The protocol lives in `skills/` — a directive change in
  `packages/mcp/src/index.ts` (`discoveryDirective`) must be mirrored in
  `skills/review/` and vice versa.
- `SPLUS.md` (repo root) is the review contract; Splus reviews itself with it.
- The engine is zero-inference and deterministic; anything nondeterministic in a
  collector or analysis pass is a bug.

## Release

Tag `vX.Y.Z` and push — `.github/workflows/release.yml` cross-compiles the
engine (macOS/Linux, arm64/x64), bundles `mcp.cjs`, packages `skills/`, and
publishes tarballs + `SHA256SUMS` that `install.sh` consumes.
