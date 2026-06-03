# Changelog

All notable changes to Splus. Format follows [Keep a Changelog](https://keepachangelog.com);
this project uses [semantic versioning](https://semver.org) (pre-1.0: minor versions may break).

## [0.5.0] — precision-first

The engine earns its keep; the review becomes a real protocol; the pitch gets honest. Measured on
the independent Martian bench (via `claude -p`, calibrated judge): **F1 73% vs CodeRabbit 36%** on
Sentry PRs.

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
