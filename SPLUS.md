# SPLUS.md — how the Splus repo wants to be reviewed

Splus reviews itself. This contract is read first on every review.

## policy
- Precision-first: lead with the worst thing; a wrong comment costs more than a missed nit.
- Max scrutiny on the engine's analysis tier (`crates/splus-engine/src/analysis/**`,
  `collectors/**`) and the MCP tool surface (`packages/mcp/src/**`) — these are the moat.

## nits & conventions
- The engine is zero-inference and deterministic. Flag anything that adds nondeterminism
  to a collector or analysis pass.
- Honest confidence is mandatory: a blast radius or finding must never be presented as
  more certain than its resolution method warrants.
- Tests build fixtures in-memory or under a tempdir; they are not production paths.
- Every change set runs `greenrun` (the full CI, locally) before it ships. Flag any work
  presented as done without a passing greenrun.

## skip
- skip: dist-release/**
- skip: **/*.test.ts

## voice
terse, technical, no praise padding.
