<div align="center">

# Splus

**Makes your coding agent a disciplined, precision-first reviewer — open source, 100% local.**

Splus turns **Claude Code · Codex · OpenCode** into a reviewer that only looks at *new* lines,
reasons from **grounded facts** (secrets, security sinks, cross-file blast radius) instead of
vibes, runs a real **review protocol** (detect → impact → triage → remediate → **verify**), and
**learns** what your team waves off *and* what it cares about. A deterministic Rust engine supplies
the grounding; your agent does the reviewing. No account, no token, nothing leaves your machine.

[![CI](https://github.com/kiwi-init/splus/actions/workflows/ci.yml/badge.svg)](https://github.com/kiwi-init/splus/actions/workflows/ci.yml)

</div>

---

## Install

```sh
curl -fsSL https://splus.sh/install.sh | sh
```

This downloads the engine + a local MCP server into `~/.splus` and wires it into every coding
agent it finds (Claude Code, Codex, OpenCode). Then, in your agent:

> "review my staged changes with splus"

Requirements: **git** and **node ≥ 20**. Update anytime with:

```sh
splus update
```

Updates preserve existing agent wiring and use compact output. Re-run the install
one-liner if upgrading from a release that predates the `splus` update command.

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

Nothing leaves your machine — there's no cloud step and no API key. The coding agent already in
your editor is the reviewer.

## The MCP tools

Your agent connects to the local server and calls these:

| Tool          | What it does                                                                |
| ------------- | --------------------------------------------------------------------------- |
| `review`      | Read `SPLUS.md`, return the deterministic floor + a directive, drive the review. |
| `inspect`     | The engine **on tap**: `definition` · `callers` · `blast_radius` · `complexity` · `exports` · `imports` — investigate on demand. |
| `floor`       | Re-ground on the deterministic finding floor for a scope (no directive).    |
| `preferences` | Show the merged `SPLUS.md` contract (repo + `~/.splus`).                     |
| `recall`      | Surface past confirmed findings / conventions relevant to a hunk.           |
| `note`        | Remember a repo convention you discovered (→ `recall`).                      |
| `dismiss`     | Teach Splus a finding is noise — it generalizes to close variants.          |
| `accept`      | Teach Splus a finding was real — reinforces, and becomes recallable.        |
| `mute`        | Mute an entire rule for this repo.                                          |
| `learnings`   | List what's been learned on this repo.                                      |
| `report`      | Render the review as a standalone offline HTML report.                      |
| `index`       | Build a SCIP index locally for the precise (compiler-grade) blast-radius tier. |

Agent-led, one flow: `review` injects the repo's `SPLUS.md` contract and returns the grounded
deterministic floor; **you** drive the review — pull signal on demand with `inspect`, verify before
posting, then `report` and teach. No API key, ever — the model already in your editor does the
reasoning. Learnings stay per-repo in `.splus-cache/` (suppressions in `learnings.json`, memory in
`memory.json`) — they never leave your checkout.

### `SPLUS.md` — the repo's review contract

Drop a `SPLUS.md` at the repo root (layered over your personal `~/.splus/SPLUS.md`). Splus reads it
**first** on every review: prose preferences/nits guide the reviewer, and binding `mute: <ruleId>` /
`skip: <glob>` lines drop matching findings (and say so — never silently). The `prefs` skill scaffolds one.

### Skills

The `skills/` bundle drives the agent-led flow: `review` (fans out **fresh, unbiased sub-agents** per
unit — finder ≠ verifier — and degrades to a sequential pass where sub-agents aren't available) and
`prefs` (author `SPLUS.md`).

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

The engine emits *only* grounded, diff-scoped findings. The actual reviewing — the protocol
(triage → discover → verify) and the learned memory (`dismiss` / `accept` / `mute`) — lives in the
agent flow over MCP, where the agent in the chair is the reviewer.

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

100% local. No account, no token, no API key, no telemetry, no phone-home. The engine runs on
your checkout; diffs are never uploaded. The reasoning is done by the coding agent already in your
editor — Splus itself makes no network calls.

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
  triage/              # benchmark harness — runs the protocol headlessly to measure it (not a usage path)
  mcp/                 # the local MCP server your agent talks to — the one and only way to use Splus
bench/                 # regression gate (run.mjs) + the Martian benchmark adapter (martian/)
docs/                  # ARCHITECTURE.md · TOOLS.md
install.sh             # the one-line installer
```

The marketing site (splus.sh) lives in its own repo: **[kiwi-init/splus-lp](https://github.com/kiwi-init/splus-lp)**.

## License

[MIT](LICENSE).
