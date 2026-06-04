# Changelog

All notable changes to Splus. Format follows [Keep a Changelog](https://keepachangelog.com);
this project uses [semantic versioning](https://semver.org) (pre-1.0: minor versions may break).

## [0.5.1] — precision hardening

A diff-scoped reviewer lives or dies on signal-to-noise. 0.5.0's recall-first discovery could
over-fire on a single complex file — a concurrency refactor would draw a dozen speculative
"could race / may leak" comments, and the adversarial VERIFY stage (the same model judging its
own plausible reasoning) couldn't refute them. On the independent Martian bench, two Sentry PRs
alone produced ~half of all false positives. This release adds two model-independent precision
floors and corrects an over-optimistic 0.5.0 benchmark claim.

### Added
- **Per-file signal budget** — caps low/medium *ungrounded* (LLM-discovered) findings to the
  most-confident few per changed file. Deterministic engine findings and high/critical claims
  always surface; demoted findings stay visible in the suppressed list (auditable, never deleted).
  Model-independent, so it bounds the false-positive blast radius of one over-firing file.
- **Burden-of-proof VERIFY** — a low/info speculative finding now survives only if the skeptic
  pass *explicitly affirms* it (fail-closed); medium+ stays fail-open so a flaky verify call can't
  swallow a real bug.
- **`bench/martian --pr <substr>`** — target specific PRs by URL for cheap validation runs.

### Changed
- **Honest benchmark numbers.** 0.5.0 advertised "F1 73% vs CodeRabbit 36%" — that was a favorable
  5-PR subset, not the population. The real figures are below. The validated effect of this
  release: on the worst over-fire PR (getsentry/sentry#95633), false positives dropped from 8 → 4
  with no change to true positives or recall.

### Benchmark (independent Martian Code Review Bench, `claude -p`, calibrated judge)
Partial run (17/50 PRs; a session-limit cut the rest), 0.5.0 pipeline:

| | Precision | Recall | F1 |
|---|---|---|---|
| Splus 0.5.0 (17 PRs) | 43.9% | 38.3% | **40.9%** |
| CodeRabbit (baseline) | — | — | 35% |
| Target (CodeRabbit × 1.30) | — | — | 46% |

Ahead of CodeRabbit, short of the target. 0.5.1's precision floors are validated on the worst case
(8→4 FP); the full-50 re-measure on the new pipeline is the next step.

## [0.5.0] — precision-first

The engine earns its keep; the review becomes a real protocol; the pitch gets honest.

### Added
- **Native security sinks** in the engine (local, zero-dep, diff-scoped): unsafe `yaml.load` /
  `pickle` / `eval`-`exec` / `shell=True`, SQL string-interpolation, TLS-verify-off, JS SQL
  templates, `dangerouslySetInnerHTML`.
- **Adapter provisioning** in `install.sh`: downloads **gitleaks** (secrets) and **osv-scanner**
  (dependency CVEs); the engine auto-detects them on PATH. Skip with `SPLUS_NO_ADAPTERS=1`.
- **`accept` tool** + a positive-memory tier: confirmed-real findings reinforce close variants
  (the inverse of `dismiss`).
- **Adversarial VERIFY stage** in the multi-pass review — refutes plausible-but-wrong findings
  before they're posted (the precision gate).
- **`review(precise: true)`** — builds a SCIP index so blast radius is compiler-grade.
- **Docs**: `docs/ARCHITECTURE.md` (with diagrams), `docs/TOOLS.md`, a `bench/martian/` adapter
  that scores Splus on the independent Martian Code Review Bench (works with `claude -p`, no key).

### Changed
- **Complexity is opt-in (`--metrics`)** — off by default; it's near-noise and was dominating the
  floor.
- **Discovery reviews the diff**, recall-first — not whole files blind. Precision is VERIFY's job.
- **semgrep runs offline only** (local ruleset), never `--config auto` — that was a silent network
  call that broke the 100%-local guarantee.
- Repositioned: "makes your agent a disciplined, grounded, learning reviewer," not "the engine
  finds bugs."

## [0.4.0]
### Changed
- **Slimmed to the engine + MCP server.** Removed `packages/cli` (the `splus` CLI — the MCP server
  is the surface; `splus-engine` remains the CLI-shaped escape hatch for CI/pre-commit) and
  `packages/landing` (the splus.sh site moved to its own repo, `kiwi-init/splus-lp`).
- `install.sh` / release / CI build + ship the engine + MCP only.
### Fixed
- MCP `serverInfo.version` is inlined from `package.json` at bundle time (was hardcoded).

## [0.3.x]
- The engine + MCP server + (then-bundled) CLI and landing page. Deterministic pipeline, learned
  suppression, optional LLM triage + discovery.

[0.5.0]: https://github.com/kiwi-init/splus/releases/tag/v0.5.0
[0.4.0]: https://github.com/kiwi-init/splus/releases/tag/v0.4.0
