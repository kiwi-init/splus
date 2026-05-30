<div align="center">

# Splus

**The precision-first code reviewer.** The one whose comments a senior engineer almost never dismisses.

One deterministic engine · three surfaces: **GitHub App** · **local CLI** · **web dashboard**

</div>

---

## Why

Every AI reviewer races on catch-rate. The market is begging for the opposite. Independent measurement (the Martian Code Review Bench — ~200k real PRs scored by *whether the developer actually fixed the flagged line*) caps even the best tools at **~50–64% F1 / ~49–62% precision**. Roughly half of every competitor's comments get ignored. **Noise — not missed bugs — is the #1 reason teams turn these tools off.**

Splus wins on signal-to-noise **by construction**: a deterministic engine does maximal work, every finding cites a reproducible **anchor**, everything is **diff-scoped** (clean-as-you-code — only *new* code is ever flagged), and the (future) LLM stage is reserved for judgment, not scanning.

> See [`REPORT.md`](REPORT.md) for the full strategy + architecture, and [`docs/RESEARCH.md`](docs/RESEARCH.md) for the competitive/tooling research it's built on.

## What's here (this pass: the deterministic core)

```
Splus/
├── crates/splus-engine/     # Rust deterministic engine — the source of truth
│   └── src/
│       ├── diff.rs          #   git diff → clean-as-you-code added-line set
│       ├── collectors/      #   secrets · heuristics · complexity · blast-radius · external
│       ├── analysis/        #   tree-sitter symbols · cognitive complexity · cross-file graph
│       ├── pipeline.rs      #   circuit breakers → collect → dedup → severity-sort
│       └── render.rs        #   pretty · JSON · SARIF
├── packages/
│   ├── shared/              # canonical Finding model (TS, mirrors Rust) + engine runner
│   ├── cli/                 # `splus review` / `splus init-hooks`
│   └── app/                 # `@splus` GitHub App (Probot)
├── REPORT.md                # strategy, architecture, MVP plan
└── docs/RESEARCH.md         # competitive + tooling intelligence
```

### The deterministic pipeline (zero inference)

| Stage | Does | Saves inference by |
|---|---|---|
| **0 Guard** | size/generated/vendored circuit breakers | bounding cost on huge/monorepo PRs |
| **1 Diff** | `git blame` clean-as-you-code added-line set | never touching legacy/unchanged code |
| **2 Strip** | (planned) AST-diff noise strip | dropping formatting-only changes |
| **3 Collectors** | secrets (regex+entropy) · diff heuristics · external SARIF (Semgrep/ast-grep/gitleaks/OSV) | high-confidence findings with no LLM |
| **4 Blast radius** | cross-file caller graph for changed exports | structured impact facts, not guesses |
| **— Metrics** | cognitive-complexity **delta** base→head | defensible maintainability signals |

Every finding carries an **anchor** (`secret` / `metric` / `graph-edge` / `sarif` / `heuristic`) and a stable fingerprint. Cross-file claims always show an explicit **resolution confidence** — we never present a name+import heuristic as compiler-grade truth.

## Quick start

```bash
# 1. Build the engine (Rust)
cargo build --release
cargo test                       # 21 tests

# 2. Build the TS surfaces
pnpm install
pnpm -r build

# 3. Review your working tree (from inside any git repo)
export SPLUS_ENGINE=$PWD/target/release/splus-engine
node packages/cli/dist/index.js review --staged          # pretty
node packages/cli/dist/index.js review --staged --agent  # JSON for Claude Code / Cursor / Codex
node packages/cli/dist/index.js review --base origin/main # PR-style

# 4. Install a pre-commit hook (non-blocking on engine error)
node packages/cli/dist/index.js init-hooks --fail-on high
```

Or run the engine directly:

```bash
target/release/splus-engine review --staged --format pretty
target/release/splus-engine review --base main --format sarif   # GitHub code scanning
```

The GitHub App lives in [`packages/app`](packages/app/README.md).

## Status

- ✅ Rust engine: diff parsing, clean-as-you-code, secrets, heuristics, cognitive-complexity delta, cross-file blast radius, external-tool adapters (graceful), pretty/JSON/SARIF output, circuit breakers. **21 tests green.**
- ✅ CLI: `review` (pretty / `--json` / `--agent` / `--fail-on`), `init-hooks` (husky/lefthook/pre-commit).
- ✅ GitHub App: Probot skeleton — clone → engine → batched review + suggestions + neutral check; per-repo `.splus.yml`.
- ⏭️ Next: AST-diff noise strip · learned suppression store (pgvector) · LLM triage/explain layer · SCIP/LSP precise blast-radius tier · web dashboard + Trust Center.

## License

MIT.
