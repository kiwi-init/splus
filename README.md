<div align="center">

# Splus

**Makes your coding agent a disciplined, precision-first reviewer — open source, 100% local.**

Splus turns **Claude Code · Codex · OpenCode** into a reviewer that only looks at *new* lines,
reasons from **grounded facts** (secrets, security sinks, cross-file blast radius) instead of
vibes, runs a real **review protocol** (detect → impact → triage → remediate → **verify**), and
**learns** what your team waves off *and* what it cares about. A deterministic Rust engine supplies
the grounding; your agent does the reviewing. No account, no token, nothing leaves your machine.

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
measurement (the [Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark)
— real PRs scored by *whether the developer actually fixed the flagged line*) puts well-known
tools around **26–56% precision** — most of their comments get ignored. **Noise — not missed
bugs — is the #1 reason teams turn these tools off.**

Splus doesn't try to be a smarter model than the one you already run. It makes *your* agent a
disciplined reviewer:

- **Grounded, not guessing** — a deterministic Rust engine surfaces high-precision facts (secrets,
  injection / deserialization / TLS sinks, cross-file blast radius) the agent reasons *from*.
- **Diff-scoped** — only newly-added lines are ever flagged (clean-as-you-code).
- **A protocol, not one prompt** — detect → impact → triage → remediate → **verify**, where a
  skeptical pass refutes plausible-but-wrong comments before they're ever posted.
- **Quiet by default** — maintainability metrics are off unless asked; every kept finding earned it.
- **Learns both ways** — per-repo memory suppresses the noise you `dismiss` *and* reinforces the
  findings you `accept`, so the review fits your team over time.

Nothing leaves your machine; the optional LLM stage talks only to the provider you choose.

## The MCP tools

Your agent connects to the local server and calls these:

| Tool        | What it does                                                                |
| ----------- | --------------------------------------------------------------------------- |
| `review`    | Review `working` / `staged` / `base..HEAD` / whole-repo (`all`) changes.     |
| `dismiss`   | Teach Splus a finding is noise — it generalizes to close variants.           |
| `accept`    | Teach Splus a finding was real — it reinforces close variants going forward.  |
| `mute`      | Mute an entire rule for this repo.                                           |
| `learnings` | List what's been learned on this repo.                                       |
| `index`     | Build a SCIP index locally for the precise (compiler-grade) blast-radius tier. |

With an LLM key (or `claude -p`), `review` runs the full protocol (detect → impact → triage →
remediate → verify); without one it returns the grounded deterministic floor and hands your agent
the review. Learnings (both `dismiss` and `accept`) are stored per-repo in
`.splus-cache/learnings.json` — they stay in your checkout.

**Full reference: [`docs/TOOLS.md`](docs/TOOLS.md)** — every tool, parameter, and return shape.

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
| **2 Collectors** | secrets (regex+entropy) · native security sinks (injection/deser/shell/TLS) · diff heuristics · optional external SARIF (Semgrep/ast-grep/gitleaks/OSV, offline) | high-confidence findings with no LLM |
| **3 Blast radius** | cross-file caller graph for changed exports — **precise (SCIP, compiler-grade)** where an `index.scip` exists, name+import heuristic otherwise | structured impact facts, not guesses |
| **4 Metrics** *(opt-in)* | cognitive-complexity **delta** base→head — **off by default** (`--metrics`); near-zero bug correlation, so it never dilutes the floor | maintainability signal only when asked |
| **5 Memory** | per-repo learned filter — suppress what you `dismiss` (exact · rule · semantic) · reinforce what you `accept` | dropping known noise + ranking known signal |

Every finding carries an **anchor** (`secret` / `metric` / `graph-edge` / `sarif` /
`heuristic`) and a stable fingerprint. Cross-file claims always show an explicit **resolution
confidence** — Splus never presents a name+import heuristic as compiler-grade truth.

### Language support

Deep analysis (tree-sitter **symbols + cognitive-complexity + per-language security heuristics**)
covers the **top 15 languages**:

> TypeScript · JavaScript (+ TSX/JSX) · Python · Java · C# · C++ · C · Go · Rust · PHP · Ruby · Kotlin · Swift · Scala · Shell/Bash

Blast radius is **precise (SCIP, compiler-grade)** for any of these when an `index.scip` exists;
for the JS/TS family it also falls back to a name+import heuristic graph. Anything outside the 15
still degrades gracefully — secrets + the universal heuristics (merge markers, TODOs, disabled
TLS) always apply.

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

## Docs

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the engine + review protocol work (with diagrams).
- **[docs/TOOLS.md](docs/TOOLS.md)** — the MCP tools your agent calls (every param + return).
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — build, test, and the release process.
- **[bench/martian/](bench/martian/)** — score Splus on the independent Martian Code Review Bench.

## Repo layout

```
crates/splus-engine/   # the deterministic engine (Rust) — the source of truth
packages/
  shared/              # canonical Finding model (TS, mirrors Rust) + engine runner
  suppression/         # per-repo memory — suppress (dismiss) + reinforce (accept)
  triage/              # optional LLM layer — the multi-pass review (downstream of the engine)
  mcp/                 # the local MCP server your agent talks to
bench/                 # regression gate (run.mjs) + the Martian benchmark adapter (martian/)
docs/                  # ARCHITECTURE.md · TOOLS.md
install.sh             # the one-line installer
```

The marketing site (splus.sh) lives in its own repo: **[kiwi-init/splus-lp](https://github.com/kiwi-init/splus-lp)**.

## License

[MIT](LICENSE).
