# @splus/app — GitHub App

The `@splus` bot. Reviews PRs automatically or on `@splus` mention, posts one
batched review with anchored inline comments + suggestions, and sets a
non-blocking `Splus` check. Deterministic-only in this pass (no LLM).

## How it works

```
pull_request.opened/reopened/ready  ─┐
pull_request.synchronize  (new push) ─┤→ getConfig(.splus.yml) → reviewPR():
issue_comment "@splus"  (on a PR)   ─┘   clone head → splus-engine review
                                          --base <baseSha> --format json
                                          → 1 batched pulls.createReview(COMMENT)
                                          → checks.create (neutral by default)
```

Everything runs through the **same** `splus-engine` binary as the CLI, so a
finding never appears with a different verdict across surfaces.

## Configure per repo — `.splus.yml`

```yaml
auto_review: true       # review on open/push (false → mention-only)
mention_only: false     # require @splus to review
show_nits: false        # post nit-tier findings inline (default: summary only)
fail_on: off            # off | low | medium | high | critical — when the check fails
ignore_paths:
  - "packages/legacy/"
```

These are the same knobs the web dashboard writes.

## Run locally

```bash
cargo build --release                 # build the engine (repo root)
pnpm --filter @splus/app build
cp packages/app/.env.example packages/app/.env   # fill APP_ID, PRIVATE_KEY, WEBHOOK_SECRET, SPLUS_ENGINE
pnpm --filter @splus/app start        # probot run ./dist/index.js
```

Register the app from `app.yml` (least-privilege: `contents:read`,
`pull_requests:write`, `checks:write`, `issues:write`). Point the webhook at
your server (use `smee.io` for local dev).

## Notes / roadmap

- Inline comments land on clean-as-you-code added lines (always within the diff).
  If GitHub rejects a position, we fall back to a summary review (never a silent drop).
- Capped at 40 inline comments per review (precision over volume); the rest roll
  into the summary.
- Incremental review on `synchronize` currently re-reviews `base...head`; a
  per-PR last-reviewed-SHA store (review only new commits) is the next step.
- The LLM triage/explain layer is intentionally **not** here yet — this pass is
  the deterministic core.
