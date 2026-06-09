# Dispatch — fan out fresh reviewers (and degrade gracefully)

Fresh context per reviewer is the point: no author bias, no session clutter, small
windows. The orchestrator (you) holds only `SPLUS.md` + the unit list + each
sub-agent's compact result — never every file at once. This is what lets a huge
diff get a careful review.

## On Claude Code (sub-agents available)
1. **Partition** the changed files into a few coherent units (by directory /
   subsystem). Keep a unit small enough to review deeply.
2. For each unit, spawn a fresh `Task` with the `investigate.md` protocol. Give it
   ONLY:
   - the unit's file list,
   - the `SPLUS.md` contract,
   - the floor for those files (call `floor` with the scope, or pass the relevant
     slice of the `review` floor),
   - the stated intent (PR title / commit message).
   Do **not** pass this session's implementation narrative — that reintroduces the
   bias you forked to escape.
3. Collect each unit's candidate findings (compact structured results, not file
   dumps).
4. Spawn an **independent** verifier `Task` (the `verify.md` refuter) over the
   candidates. The verifier must be a different agent than any finder.
5. You synthesize: dedup, signal-budget against `SPLUS.md`, assign tiers, then
   `report` (pass `keptIds` — the floor ids your verified review keeps; its
   deterministic protocol audit lists anything unaccounted, close those gaps
   first) + teach.

For a large unit, fan out again **by lens** (one sub-agent per lens in
`lenses.md`), each blind to the others.

## On hosts without sub-agents (Codex, OpenCode, …)
The same protocol runs **sequentially** in one context:
- Review units one at a time; summarize and clear between units so the window
  stays small.
- Run the verifier as a **distinct pass** after discovery — re-read each candidate
  cold and try to refute it. The finder≠verifier discipline becomes finder-pass ≠
  verifier-pass; still drop anything you can't defend.

The tools are identical on every host — only the dispatch primitive changes. Never
hard-depend on forking; degrade, don't fail.

## Don't over-fan
One unit + one verifier is the right shape for a small diff. Fan out for breadth
(big diffs) and depth (risky units), not for its own sake. Each spawn costs
context; spend it where the risk is.
