# Changelog

All notable changes to Splus. Format follows [Keep a Changelog](https://keepachangelog.com);
this project uses [semantic versioning](https://semver.org).

## [Unreleased]

Closer to the PR review workflow: land a verified Splus review on a GitHub pull request.

### Added
- **`prReview` MCP tool** + **`@splus/shared` diff-anchor mapper** — turns the agent's
  verified survivors into a ready-to-post GitHub Pull Request Reviews payload. The mapper
  (`buildDiffAnchorIndex` / `anchorFinding` / `buildReviewPayload`) is pure and
  deterministic: it walks the PR's unified diff, resolves each finding's `file:line` to a
  RIGHT-side inline anchor (multi-line within a hunk; collapses cross-hunk), folds
  out-of-diff findings into the summary (never dropped), and picks the review event from
  the must-fix count. The server stays read-only and never shells `gh` — it returns the
  JSON and the `gh api … /reviews` command for the agent to post. The "what" (comment
  prose) stays the agent's; the "where" (the anchor) is deterministic.
- **`splus-pr-review` skill** — drives the round-trip: resolve the PR (`gh pr view` →
  base/head/number) → run the existing review protocol scoped to the PR's `base..HEAD` →
  emit verified survivors as a real PR review (inline comments + verdict). Wired into the
  installer for Claude Code / Codex / OpenCode.

## [1.1.0] — 2026-06-09

Dynamic grounding, history facts, a checkable protocol, and memory that ages.

### Added
- **Coverage collector** (engine) — reads the coverage report a test run already produced
  (lcov, Cobertura XML, Istanbul JSON, Go coverprofile; `SPLUS_COVERAGE_FILE` overrides
  discovery) and emits `tests.uncovered-added-lines` for added lines the report instruments
  at zero hits. Staleness-guarded: a report older than the file's last edit never speaks.
- **Mutation adapter** (engine) — reads Stryker `mutation.json` / cargo-mutants
  `mutants.out/missed.txt` and emits `tests.surviving-mutant` / `tests.mutant-no-coverage`
  for mutants on added lines: the suite stayed green while the line's behavior changed.
- **History collector** (engine) — one bounded `git log` walk mines `history.fix-churn`
  (this file keeps appearing in bug-fix commits) and `history.co-change-missing` (a file
  that almost always changes with this one is absent from the diff). Skipped in `--all`
  mode; capped per signal.
- **Protocol audit** (MCP) — the server now keeps a per-review ledger (floor ids handed
  out, changed-export contracts, successful `inspect` calls, `dismiss`/`accept` fates).
  `report` accepts `keptIds` and opens with a deterministic audit: changed exports never
  interrogated and floor findings with no explicit fate are listed before the deliverable
  renders. The review standard is now checked, not trusted.

### Changed
- **Suppression decay** (memory) — exact dismissals age out after 180 days, semantic
  matches after 90; an aged-out match stops suppressing and the finding resurfaces once
  with a re-validation note (re-dismiss to refresh). Rule mutes never decay. `review`
  surfaces resurfaced ids in a `Re-validation` note.

[1.1.0]: https://github.com/kiwi-init/splus/releases/tag/v1.1.0

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
