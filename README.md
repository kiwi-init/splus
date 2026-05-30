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
│   ├── suppression/        # learned per-repo noise filter (exact · rule · semantic) + pgvector
│   ├── triage/             # LLM layer — judge/explain/suppress + fix (downstream of the engine)
│   ├── cli/                 # `splus review` / `dismiss` / `mute` / `learnings` / `init-hooks`
│   ├── app/                 # `@splus` GitHub App (Probot)
│   └── dashboard/          # web console + public Trust Center (Hono + zero-build SPA)
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
node packages/cli/dist/index.js review --staged          # pretty (deterministic, $0)
node packages/cli/dist/index.js review --staged --agent  # JSON for Claude Code / Cursor / Codex
node packages/cli/dist/index.js review --base origin/main # PR-style

# Optional LLM layer: triages/explains/suppresses on top of the deterministic
# candidates (needs ANTHROPIC_API_KEY; falls back to deterministic if absent).
ANTHROPIC_API_KEY=sk-ant-... node packages/cli/dist/index.js review --staged --llm
node packages/cli/dist/index.js review --staged --llm --thorough  # + discovery pass

# 4. Install a pre-commit hook (non-blocking on engine error)
node packages/cli/dist/index.js init-hooks --fail-on high

# 5. Teach it — it gets quieter over time (per-repo, exact + rule + semantic)
node packages/cli/dist/index.js dismiss <finding-id>   # stop flagging this + close variants
node packages/cli/dist/index.js mute hygiene.python-print  # mute a whole rule
node packages/cli/dist/index.js learnings              # what it has learned

# 6. Web console + public Trust Center (seeds sample data on first run)
pnpm --filter @splus/dashboard start   # → http://localhost:4040  ·  /trust
```

Or run the engine directly:

```bash
target/release/splus-engine review --staged --format pretty
target/release/splus-engine review --base main --format sarif   # GitHub code scanning
```

The GitHub App lives in [`packages/app`](packages/app/README.md).

## Status

- ✅ Rust engine: diff parsing, clean-as-you-code, secrets, heuristics, cognitive-complexity delta, cross-file blast radius, external-tool adapters (graceful), pretty/JSON/SARIF output, circuit breakers. **21 tests green.**
- ✅ CLI: `review` (pretty / `--json` / `--agent` / `--fail-on` / `--llm`), `init-hooks` (husky/lefthook/pre-commit).
- ✅ GitHub App: Probot skeleton — clone → engine → (optional LLM triage) → batched review + suggestions + neutral check; per-repo `.splus.yml`.
- ✅ **LLM layer** (`@splus/triage`): strictly downstream of the engine. Haiku-4.5 triage (keep/suppress + confidence + rationale + fix via forced tool-use, sharded, prompt-cached); opt-in Opus-4.8 discovery pass. Fails open — deterministic core works with zero inference.
- ✅ **Learned suppression** (`@splus/suppression`): per-repo noise filter — exact (dismissed fingerprint), rule-mute, and **semantic** (cosine over a dependency-free feature-hash embedder; pgvector backend for hosted). Dismiss one finding → its whole class goes quiet. Wired into the CLI (`dismiss`/`mute`/`learnings`) and the App (`@splus mute <rule>`), applied before LLM spend.
- ✅ **Web console + Trust Center** (`@splus/dashboard`): Hono + zero-build SPA. Org/repo overview, the **falling-false-positive / precision-over-time** hero chart (hand-rolled SVG), per-repo config editor (writes `.splus.yml`), a Learnings manager over the real suppression store, a transparent per-author billing meter, and a public Trust Center (no-training, ephemeral retention, self-host/BYO-LLM, provider-neutral, SOC 2, published-precision methodology).
- ⏭️ Next: AST-diff noise strip · SCIP/LSP precise blast-radius tier · incremental-on-synchronize · richer transformers embedder · persist the dashboard config back to the repo / Postgres.

## License

MIT.
