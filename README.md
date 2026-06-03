<div align="center">

# Splus

**The precision-first code reviewer — open source, and 100% local.**

A deterministic Rust engine your coding agent (**Claude Code · Codex · OpenCode**) calls over
MCP. It reviews only *new* lines, proves every finding, maps the cross-file blast radius, and
learns the noise you wave off. No account, no token, nothing leaves your machine.

[![CI](https://github.com/kiwi-init/splus/actions/workflows/ci.yml/badge.svg)](https://github.com/kiwi-init/splus/actions/workflows/ci.yml)
[![Splus self-review](https://github.com/kiwi-init/splus/actions/workflows/splus-review.yml/badge.svg)](https://github.com/kiwi-init/splus/actions/workflows/splus-review.yml)

</div>

---

## Install

```sh
curl -fsSL https://splus.sh/install.sh | sh
```

This downloads the engine + a local MCP server into `~/.splus` and wires it into every coding
agent it finds (Claude Code, Codex, OpenCode). Then, in your agent:

> "review my staged changes with splus"

Requirements: **git** and **node ≥ 20**. Update anytime by re-running the one-liner.

<details>
<summary>Wire an agent manually</summary>

```sh
# Claude Code
claude mcp add --scope user splus -- ~/.splus/bin/splus-mcp
```
```toml
# Codex — ~/.codex/config.toml
[mcp_servers.splus]
command = "~/.splus/bin/splus-mcp"
```
```json
// OpenCode — ~/.config/opencode/opencode.json
{ "mcp": { "splus": { "type": "local", "command": ["~/.splus/bin/splus-mcp"], "enabled": true } } }
```
</details>

## Why

Every AI reviewer races on catch-rate, and the market is begging for the opposite. Independent
measurement (the Martian Code Review Bench — ~200k real PRs scored by *whether the developer
actually fixed the flagged line*) caps even the best tools at **~50–64% F1 / ~49–62%
precision**. Roughly half of every competitor's comments get ignored. **Noise — not missed
bugs — is the #1 reason teams turn these tools off.**

Splus wins on signal-to-noise **by construction**: a deterministic engine does maximal work,
every finding cites a reproducible **anchor**, everything is **diff-scoped** (clean-as-you-code
— only *new* code is ever flagged), and the optional LLM stage is reserved for judgment, not
scanning. Your agent stays the reviewer; Splus supplies precise, provable findings.

## The MCP tools

Your agent connects to the local server and calls these:

| Tool        | What it does                                                                |
| ----------- | --------------------------------------------------------------------------- |
| `review`    | Review `working` / `staged` / `base..HEAD` / whole-repo (`all`) changes.     |
| `dismiss`   | Teach Splus a finding is noise — it generalizes to close variants.           |
| `mute`      | Mute an entire rule for this repo.                                           |
| `learnings` | List what's been suppressed on this repo.                                    |
| `index`     | Build a SCIP index locally for the precise (compiler-grade) blast-radius tier. |

Learnings are stored per-repo in `.splus-cache/learnings.json` — they stay in your checkout.

## In CI / pre-commit

The installer also puts the deterministic engine, `splus-engine`, on your PATH — no
account, no token, runs in milliseconds. Use it as a non-blocking gate or in a hook:

```sh
splus-engine review --staged --format pretty             # pretty, deterministic, $0
splus-engine review --staged --format json               # JSON for an agent / tooling
splus-engine review --base origin/main --format sarif    # PR-style → GitHub code scanning
splus-engine review --staged --fail-on high              # exit non-zero at/above a severity
```

The engine emits *only* grounded, diff-scoped findings. Learned suppression
(`dismiss` / `mute` / `learnings`) and the optional LLM judgment live in the agent
flow over MCP — that's where the reviewing happens.

## How it works — the deterministic pipeline (zero inference)

| Stage | Does | Saves inference by |
|---|---|---|
| **0 Guard** | size/generated/vendored circuit breakers | bounding cost on huge/monorepo diffs |
| **1 Diff** | `git` clean-as-you-code added-line set | never touching legacy/unchanged code |
| **2 Collectors** | secrets (regex+entropy) · diff heuristics · external SARIF (Semgrep/ast-grep/gitleaks/OSV) | high-confidence findings with no LLM |
| **3 Blast radius** | cross-file caller graph for changed exports — **precise (SCIP, compiler-grade)** where an `index.scip` exists, name+import heuristic otherwise | structured impact facts, not guesses |
| **4 Metrics** | cognitive-complexity **delta** base→head | defensible maintainability signals |
| **5 Suppress** | per-repo learned filter (exact · rule · semantic) | dropping known noise before you ever see it |

Every finding carries an **anchor** (`secret` / `metric` / `graph-edge` / `sarif` /
`heuristic`) and a stable fingerprint. Cross-file claims always show an explicit **resolution
confidence** — Splus never presents a name+import heuristic as compiler-grade truth. Deep
analysis (symbols, complexity, blast radius) covers **TypeScript / JavaScript / TSX / Python**;
other languages degrade gracefully (secrets + heuristics still apply).

## Privacy

100% local. No account, no token, no telemetry, no phone-home. The engine runs on your
checkout; diffs are never uploaded. The optional LLM triage is off unless you set a key, and
then it talks only to the provider you chose.

## Build from source

```sh
cargo build --release        # the engine → target/release/splus-engine
cargo test                   # engine tests
pnpm install && pnpm -r build
pnpm build:release           # bundle the MCP server → dist-release/mcp.cjs
```

Run the engine directly if you like:

```sh
target/release/splus-engine review --staged --format pretty
target/release/splus-engine review --base main --format sarif   # GitHub code scanning
```

Cutting a release: tag `v*` and push — `.github/workflows/release.yml` cross-compiles the
engine for macOS/Linux, bundles the MCP server, and publishes a GitHub Release that `install.sh`
pulls from. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Repo layout

```
crates/splus-engine/   # the deterministic engine (Rust) — the source of truth
packages/
  shared/              # canonical Finding model (TS, mirrors Rust) + engine runner
  suppression/         # learned per-repo noise filter (exact · rule · semantic)
  triage/              # optional LLM layer — judge/explain/suppress (downstream of the engine)
  mcp/                 # the local MCP server your agent talks to
install.sh             # the one-line installer
docs/RESEARCH.md       # competitive + tooling research
```

The marketing site (splus.sh) lives in its own repo: **[kiwi-init/splus-lp](https://github.com/kiwi-init/splus-lp)**.

## License

[MIT](LICENSE).
