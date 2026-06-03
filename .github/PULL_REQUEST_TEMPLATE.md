<!-- Thanks for contributing to Splus! Keep it diff-scoped and quiet-by-default. -->

## What & why

<!-- What does this change, and why? Link any issue: Closes #123 -->

## Checklist

- [ ] `cargo test` and `pnpm -r build && pnpm -r typecheck` pass
- [ ] `node bench/run.mjs` (the regression gate) still passes — new rules must not fire on benign code
- [ ] If you added/changed a rule: it's **high-precision** and **diff-scoped** (added a test + a benign guard)
- [ ] If you changed the `Finding` model: the Rust (`model.rs`) and TS (`shared`) sides stay in lockstep
- [ ] Docs updated if behavior/tools changed (`README.md` · `docs/TOOLS.md` · `docs/ARCHITECTURE.md`)

## Notes

<!-- Anything reviewers should know. Splus reviews its own PRs (advisory) — see the Actions summary. -->
