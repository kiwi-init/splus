# Changelog

All notable changes to Splus. Format follows [Keep a Changelog](https://keepachangelog.com);
this project uses [semantic versioning](https://semver.org).

## [1.0.0] — 2026-06-06

Initial public release.

- **Deterministic Rust engine** (`splus-engine`) — the zero-inference finding floor:
  diff-scoped collectors (secrets, native security sinks, heuristics, optional external
  SARIF adapters), cross-file blast radius (SCIP compiler-grade or name+import heuristic),
  cognitive-complexity deltas. Deep analysis across the top 15 languages.
- **Local MCP server** (`splus-mcp`) — the agent-led review surface: `review` reads the
  repo's `SPLUS.md` contract and returns the grounded floor plus a directive; `inspect` /
  `floor` put the engine on tap; `report` renders an offline HTML deliverable; `index`
  builds a SCIP index for the precise tier.
- **Per-repo memory** — `dismiss` suppresses noise (exact · rule · semantic), `accept`
  reinforces real findings, `note` / `recall` compound discovered conventions across
  sessions. Security rules are exempt from semantic suppression.
- **Skills** — the review protocol ships as first-class skills (`review`, `prefs`),
  installed into Claude Code, Codex, and OpenCode by the installer.
- **One-line installer** — `curl -fsSL https://splus.sh/install.sh | sh` puts the engine +
  MCP server in `~/.splus`, verifies optional adapters against upstream checksums, and
  wires every detected agent. 100% local: no account, no API key, no telemetry.

[1.0.0]: https://github.com/kiwi-init/splus/releases/tag/v1.0.0
