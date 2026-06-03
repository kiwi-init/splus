# Splus on the Martian Code Review Bench

The **independent** scoreboard for "is Splus actually better than CodeRabbit?" —
[withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark):
50 real PRs from 5 OSS projects, human-curated golden comments, an LLM judge. Other
tools are already scored on the same PRs, so this is apples-to-apples.

This is the real measurement. `bench/run.mjs` (one level up) is **only** a regression
gate on the engine — not a competitive claim.

## The bar (from the published leaderboard, Opus judge, 50 PRs)

| Tool | Precision | Recall | F1 |
|---|---|---|---|
| best (cubic-v2) | 56% | 69% | 62% |
| bare Claude Code | 35% | 41% | 38% |
| **CodeRabbit** | **26%** | **56%** | **35%** |

**"30% better than CodeRabbit" = F1 ≥ 46%.** The real test is whether Splus's
grounding + protocol makes a model beat *bare Claude* (38%), not just CodeRabbit.

## Run it

```sh
# Build splus first: cargo build --release && pnpm -r build

# Harness check — runs end-to-end on the deterministic floor (no key, ~free).
# Expect ~0 candidates: the floor grounds, it doesn't review. That's the point.
node bench/martian/run.mjs --limit 3

# The real head-to-head — needs an Anthropic key (splus's agent pass + the judge).
ANTHROPIC_API_KEY=sk-ant-... node bench/martian/run.mjs --judge

# Scope to Splus's strength (deep analysis is TS/Python):
ANTHROPIC_API_KEY=... node bench/martian/run.mjs --judge --repo cal.com,sentry
```

Flags: `--limit N`, `--repo a,b` (filter by source repo), `--judge` (score vs golden
comments; needs a key), `SPLUS_JUDGE_MODEL` (default `claude-opus-4-8`).

## How it works

For each PR: fetch metadata + changed files (GitHub API), materialize a temp git repo
with each file's **base** (at the merge-base) and **head** content, stage the change,
and run Splus on exactly the diff — the floor always, and the multi-pass agent review
(detect → impact → triage → remediate → **verify**) when a key is set. With `--judge`,
an LLM semantically matches Splus's candidates to the golden comments → precision /
recall, micro-averaged to F1.

## Honesty notes

- **No key → no F1.** The golden comments are reasoning bugs the deterministic floor
  can't catch alone; the headline number requires the agent pass + the semantic judge.
  The floor-only run is a harness check, not a score.
- **Judge variance.** Like Martian, the judge is an LLM; results are reported per judge
  model. Use the same model Martian published with (`claude-opus-4-5`) to compare directly.
- **Training-data leakage.** The offline set is static; tools may have seen these PRs.
  Martian's online benchmark mitigates this — a future target.
- **Language scope.** Deep analysis is TS/Python (Sentry + Cal.com, 20 PRs); Go/Ruby/Java
  (Grafana/Discourse/Keycloak) lean on the language-agnostic agent pass + floor.
