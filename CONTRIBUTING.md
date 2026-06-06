# Contributing to Splus

Thanks for helping make code review quieter. Splus is a deterministic Rust engine plus a thin
TypeScript layer (a local MCP server). It runs entirely locally — there's no service to
stand up. Start with **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full picture.

## Layout

- `crates/splus-engine/` — the deterministic engine (Rust). The source of truth for findings.
- `packages/shared/` — the canonical `Finding`/`Report` model (TS, mirrors the Rust serde model) + `runEngine`, which shells out to the engine binary.
- `packages/suppression/` — per-repo memory: suppress (`dismiss`) + reinforce (`accept`).
- `packages/mcp/` — the local stdio MCP server your agent connects to. Tools: see [docs/TOOLS.md](docs/TOOLS.md).
- `skills/` — the review protocol as agent skills (`review`, `prefs`); `install.sh` installs them into Claude Code / Codex / OpenCode. A directive change in `packages/mcp` must be mirrored here, and vice versa.

The splus.sh marketing site lives in its own repo, [kiwi-init/splus-lp](https://github.com/kiwi-init/splus-lp).

## Develop

```sh
cargo build --release        # engine → target/release/splus-engine
cargo test                   # engine tests
pnpm install
pnpm -r build                # build the TS packages
pnpm -r typecheck
pnpm -r test                 # unit tests (shared + suppression)
greenrun --plain             # the full CI, locally — must PASS before pushing
```

Run the freshly built engine directly:

```sh
target/release/splus-engine review --staged --format pretty
```

The MCP server (what your agent talks to) shells out to the engine; point it at your build with
`SPLUS_ENGINE=$PWD/target/release/splus-engine node packages/mcp/dist/index.js`.

The engine model (`crates/splus-engine/src/model.rs`) and the TS model
(`packages/shared/src/index.ts`) must stay in lockstep — change them together.

## Adding a rule (the bar)

Rules earn their place by **precision**. A new detector must:

1. live in the engine with a reproducible **anchor**, and be **diff-scoped** (added lines only);
2. ship a test that it **fires** on the bug *and* a guard that it **does not** fire on the safe form
   (e.g. the SQL-interpolation rule must ignore `%s` placeholders in parameterized queries).

A rule that adds noise to benign code does not merge — quiet-by-default is the product.

## Release

Tag a version and push:

```sh
git tag v1.0.0 && git push --tags
```

`.github/workflows/release.yml` cross-compiles the engine for macOS/Linux (arm64 + x64),
bundles the MCP server into a single `.cjs` file (`scripts/build-release.mjs`), packages
`skills/`, and publishes a GitHub Release with per-platform tarballs + `SHA256SUMS`.
`install.sh` pulls these from the stable `releases/latest/download/splus-<os>-<arch>.tar.gz`
URL. Versions bump in lockstep across all `package.json` files + `Cargo.toml`, with a
`CHANGELOG.md` entry.

## Principles

- **Deterministic floor.** High-confidence facts (secrets, sinks, blast radius) belong in the
  engine, each with a reproducible anchor. The agent reasons *from* them.
- **Recall in detect, precision in verify.** The discovery pass (the agent over the *diff*) flags
  everything plausible (recall); the adversarial VERIFY pass refutes false findings before they're
  posted (precision). Don't make detect timid — make verify strict.
- **Diff-scoped.** Only newly-added lines are ever flagged (clean-as-you-code).
- **Quiet by default.** A noisy comment costs more than a missed nit. Everything runs with zero
  config; quietness comes from precision (delta-only metrics, diff-scoping), not from switches.
- **Local.** No network calls on the hot path; no telemetry. The only network touches are opt-in
  (`review precise:true` / `index` may fetch a SCIP indexer via npx; osv-scanner on lockfile changes).
