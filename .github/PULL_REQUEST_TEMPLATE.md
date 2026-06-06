<!-- Thanks for contributing to Splus! Keep it diff-scoped and quiet-by-default. -->

## What & why

<!-- What does this change, and why? Link any issue: Closes #123 -->

## Checklist

- [ ] `cargo test`, `pnpm -r build && pnpm -r typecheck`, and `pnpm -r test` pass
- [ ] If you added/changed a rule: it's **high-precision** and **diff-scoped** (added a test + a benign guard — new rules must not fire on benign code)
- [ ] If you changed the `Finding` model: the Rust (`model.rs`) and TS (`shared`) sides stay in lockstep
- [ ] Docs updated if behavior/tools changed (`README.md` · `docs/TOOLS.md` · `docs/ARCHITECTURE.md`)

## Notes

<!-- Anything reviewers should know. -->
