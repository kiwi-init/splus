# @splus/dashboard — web console + Trust Center

A zero-build SPA (Hono server, vanilla JS, hand-rolled SVG charts) with an
oscilloscope/signal-lab aesthetic. It reads and writes the **same** per-repo
stores the CLI and GitHub App use — one source of truth.

## Run

```bash
cargo build --release            # (only needed if you also run reviews)
pnpm --filter @splus/dashboard build
pnpm --filter @splus/dashboard start     # → http://localhost:4040
```

On first run it seeds clearly-labeled **sample** data (every metric is badged
`sample` in the UI) so the console isn't empty. Force a reseed with
`SPLUS_SEED_FORCE=1`, or `pnpm --filter @splus/dashboard seed`.

Data lives under `SPLUS_DATA_DIR` (default `./.splus-data`) — the same dir the
GitHub App writes learnings to.

## Screens

- **Overview** — org precision, every repo's mode/LLM state, precision + 4-week trend.
- **Repo** — the hero chart (**signal rising / noise floor falling**), the
  `.splus.yml` config editor, and a Learnings manager over the live suppression
  store (restore a dismissal/mute and the finding comes back).
- **Usage & billing** — per active PR author; bots and reviewers aren't billed.
- **Trust Center** (`/trust`, public) — no-training guarantee, ephemeral
  retention, self-host/BYO-LLM, provider-neutral, SOC 2 status, and the honest
  published-precision methodology.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/overview` | repos + precision/trend |
| GET·PUT | `/api/repos/:owner/:name/config` | `.splus.yml`-shaped config |
| GET | `/api/repos/:owner/:name/metrics` | weekly precision / fp-rate series |
| GET·DELETE | `/api/repos/:owner/:name/learnings` | suppression entries (delete = restore) |
| GET | `/api/billing` | transparent per-author meter |
| GET | `/api/trust` | Trust Center facts |

## Roadmap

- Auth (GitHub OAuth) + multi-org.
- Write config back to the repo's `.splus.yml` (PR) or the hosted DB instead of
  the local file store.
- Swap `FileSuppressionStore` for `PgVectorSuppressionStore` in production.
