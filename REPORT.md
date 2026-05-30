# Splus — The Holy Grail of Code Review

**Strategy, architecture, and build plan.**
Status: founding design doc · Date: 2026-05-30 · Source: 21-track research sweep + red-team (see [`docs/RESEARCH.md`](docs/RESEARCH.md)).

---

## 0. TL;DR

We are not building "another AI reviewer." We are building the **most trustworthy** reviewer: the one whose comments a senior engineer almost never dismisses. The entire market converges on one truth — **noise, not missed bugs, is the #1 reason teams turn these tools off.** Independent measurement (Martian Code Review Bench, ~200k real PRs scored by *whether the developer actually fixed the flagged line*) caps even the best tools at **~50–64% F1 / ~49–62% precision**. Roughly half of every competitor's comments get ignored.

**Splus wins on signal-to-noise by construction.** A deterministic engine does maximal work; the LLM is reserved for judgment, reachability, and explanation. We reuse the mature **Matrix** tree-sitter + symbol-graph engine as the seed, wrap mature deterministic collectors (Semgrep CE, ast-grep, OSV, gitleaks, complexity-delta) normalized to SARIF, scope everything to the PR diff (clean-as-you-code), and gate every comment behind a confidence/severity tier with a learned per-team suppression loop.

Three surfaces, one engine: **GitHub App** (auto or @mention, configured from a web dashboard) · **local CLI** (review before commit) · **web dashboard** (config, trust center, falling-FP metric).

> ⚠️ **One honest correction up front** (from the red-team): a "deterministic anchor" buys *provenance and reproducibility*, not *correctness*. Semgrep/taint/complexity are themselves top false-positive sources. So the wedge is **not** "anchored = precise." The wedge is **anchored candidates + ruthless diff-scoping + learned suppression + severity tiering + an LLM judge that answers one question: _would a senior reviewer actually flag this?_** Precision is engineered in the suppression/triage layer, measured per-rule from day one — not asserted.

---

## 1. The market, honestly

| Tool | Funding / status | Pricing (per active PR author/mo) | Real strength | Documented weakness |
|---|---|---|---|---|
| **CodeRabbit** | ~$40M ARR, $550M val | Lite ~$12 · Pro ~$24 · Ent ~$15k/mo@500 | Category leader; 40–50+ bundled linters/SAST, ast-grep grounding, learnings memory, broad platform/IDE/CLI | **Noise**: one study 21% nitpick + 15% useless; 10–20 min latency; diff-centric context degrades on multi-service PRs |
| **Greptile** | YC W24, $180M val | $30 incl. 50 reviews, then $1/review | Highest recall; full-repo HyDE docstring graph; team-vector noise filter; auto-mined NL rules | Worst FP profile (self-benchmark 82%→45% when re-run independently); per-review pricing backlash; no approval gate |
| **Qodo Merge / PR-Agent** | $120M raised; OSS core (Apache-2.0) | Free 30 PRs · Teams $30 | Best-documented PR-compression pipeline; self-reflection 0–10 scoring; ticket-compliance | Diff-scoped, weak cross-file; ~25% FP; large PRs silently lose coverage |
| **Graphite Agent (Diamond)** | Acq. by Cursor Dec 2025 | Starter $20 · Team $40 | Extreme low-noise (<5% negative-comment over 500k PRs), seconds-fast, strong eval flywheel | Catches very few bugs (6% in one benchmark); opaque; now Cursor-locked |
| **Copilot review / Cursor BugBot / Gemini** | Platform-native | Copilot Bus. $19 · BugBot →$1–1.5/run | **Distribution**; Copilot Autofix+CodeQL is the strongest security-fix layer (9 langs) | All diff-only/shallow context; Copilot re-posts dismissed comments, reads only 4k chars of instructions; all drifting to opaque metering |
| **SonarQube Cloud** | Incumbent SAST | LOC-based; free <50k LOC | 6–7k deterministic rules/40+ langs; cognitive complexity; taint dataflow; Quality Gates; **Clean-as-You-Code** | Not AI; Code Smell noise; legacy-debt fatigue without new-code gating |
| **Long tail** (Korbit, Ellipsis, Bito, CodeAnt, Baz, Devin) | various | $15–24 | Pockets of genius: Ellipsis team-feedback learning + tested fixes; Baz difftastic AST-diff; CodeAnt EPSS-prioritized security across 4 platforms | Thin verifiable accuracy; bundling external SAST reintroduces FP noise |

**The pattern:** everyone is racing on catch-rate and features; the buyer is begging for *quiet and correct*. That gap is the whole opportunity.

---

## 2. Why Splus wins (the wedge)

1. **Precision-first by construction.** Default quiet. Every comment carries a deterministic anchor (SARIF result, graph edge, metric delta) *and* survives an LLM "senior-reviewer" judge *and* a learned suppression check. No anchor → auto-tagged `ai-only / low-confidence`, hidden unless `thorough` mode is on.
2. **A real persisted cross-file reference graph** — not diff-only, not an LLM tool-loop. Catches the cross-file dependency breaks Copilot/Gemini/Qodo are structurally blind to. *This is the moat — and the hardest thing to build (see §6, §9).*
3. **Clean-as-you-code from day one.** `git blame`-resolved changed-line set; only surface what is *new* in this PR. Never re-flag legacy debt — the exact behavior that generates competitor noise.
4. **Determinism + caching kills the non-determinism complaint.** Findings keyed by `(diff-hash, index-version, rule-version)` return identical results on re-run. (We restrict this guarantee to deterministic stages; LLM-tier comments are labeled as such — temp-0 is *not* reproducible across model versions.)
5. **Honest, reproducible precision.** We publish our own auditable harness + a public per-team *falling false-positive* dashboard. We use the Martian methodology internally but never stake the brand on topping a third-party benchmark we don't govern.
6. **Cost & latency advantage — designed, not asserted.** Hard wall-clock budget (p95 < 3 min on the blocking path); anything that can't fit (SCIP, live secret-verification, multi-degree graph rebuild) moves to **async enrichment** posted as a follow-up. The pre-pass eliminates most candidates before any token spend; aggressive prompt-caching of stable graph context.
7. **Trust-first "Switzerland."** Provider-neutral (GitHub → GitLab → Bitbucket), BYO-LLM, self-host, no-training guarantee, ≤48h/ephemeral retention, "no raw code stored after indexing" (HyDE-style docstring embeddings). A clean opening against IDE-vendor lock-in (Cursor+Graphite) and opaque metering.

---

## 3. The deterministic-first pipeline

The spine of the product. Each stage removes candidates (and tokens) before the next. **Circuit breakers run *before* stage 1** (red-team priority): max changed-files, max diff bytes, generated/vendored/lockfile detection (linguist-style), blast-radius fan-out caps. On trip, we degrade explicitly ("PR too large — ran secrets + CVE only") rather than blowing the latency/cost budget.

| # | Stage | What it does | How it saves inference |
|---|---|---|---|
| **0** | **Guard / circuit breakers** | Size caps, generated/vendored detection, fan-out caps, ecosystem detect | Bounds cost/latency on the large/monorepo/dep-bump PRs that matter most |
| **1** | **Diff parse + clean-as-you-code** | base→head diff, changed line ranges, `git blame` new-code set, tree-sitter incremental parse of *changed files only* | Nothing touches unchanged/legacy code — the largest noise source removed deterministically |
| **2** | **AST-diff noise strip** | difftastic / ast-grep structural diff: drop formatting, whitespace, comment-only, deletion-only changes | The LLM never wastes a call judging a reformat; smaller payload |
| **3** | **Deterministic collectors (parallel, SARIF)** | Semgrep CE (~2,800 OSS rules, intraprocedural taint) · ast-grep curated rules · OSV.dev `/v1/querybatch` + lockfile diff · gitleaks→(opt-in)trufflehog · CVSS+EPSS+KEV scoring · cognitive-complexity + Rabin-Karp duplication on changed funcs | Bulk of high-confidence findings (secrets, CVEs, injection patterns, complexity deltas) with **zero inference, zero hallucination** |
| **4** | **Cross-file blast radius (the moat)** | Persisted reference graph: multi-degree blast radius of changed symbols, new dead code / cycles, signature/rename breaks at call sites | LLM gets **structured graph facts** instead of guessing impact — kills hallucinated impact claims, catches cross-file bugs |
| **5** | **Filter / baseline / dedup / suppress** | Intersect with changed lines (reviewdog added-mode) · baseline out pre-existing · stable fingerprint dedup · pgvector noise filter (suppress if cosine-similar to ≥3 downvoted) · per-team learned rules | The single biggest token-and-noise lever — only *new, unique, non-suppressed* candidates survive |
| **6** | **Token-budgeted context assembly** | Qodo-style two-phase compression; graph-driven blast-radius context selector (~6.8× token reduction); linked-ticket acceptance criteria (GitHub/Jira/Linear) | Bounds per-PR token spend predictably; sends only the graph-relevant slice |

> **Anchor ≠ precision (carried through).** Stage 3/4 anchors are *candidates*, not verdicts. The precision work lives in stage 5 (suppression/baseline/dedup) and stage 7 (LLM judge). We track **per-rule precision** and downrank noisy rules rather than trusting "it has an anchor."

---

## 4. LLM orchestration (strictly downstream)

The LLM never free-scans raw code. It runs only on the short surviving candidate list, each carrying its anchor + graph context.

- **A. Triage (cheap/fast model, low temp).** Batched — but **sharded by file/severity** with bounded context to avoid lost-in-the-middle collapse on high-finding PRs (red-team fix; *not* one mega-call). Decides keep/suppress, assigns `nit | concern | must-fix` + confidence, confirms reachability from supplied graph facts.
- **B. Judgment-only discovery (frontier model, budget-capped).** Reserved for what determinism can't reach: business-logic flaws, IDOR/broken-auth, intent-vs-acceptance-criteria mismatch. Runs only on graph-selected blast-radius context; **must cite a code location validated against the index** (kills hallucinations).
- **C. Verify + line-range gate.** LLM-as-judge + a deterministic line-range validator drops comments that don't map to changed/relevant lines (and respect GitHub's stricter diff-position rules), merges duplicates-by-meaning, enforces the confidence threshold before posting.
- **D. Explain + fix.** For survivors only: rationale + a committable ` ```suggestion ` block.

**Routing & cost:** cheap model for triage/explain, frontier only for discovery; aggressive prompt-caching of stable graph context (~75% inference-cost reduction target); whole batch posts as **one** GitHub review call.

---

## 5. System architecture

```
                    ┌─────────────────────────────────────────────┐
   GitHub webhook   │  Webhook & Auth (Probot/Octokit)            │
  ─────────────────▶│  verify sig · per-install token · last SHA  │
                    └───────────────┬─────────────────────────────┘
                                    │ enqueue (debounce synchronize bursts)
                    ┌───────────────▼─────────────────────────────┐
                    │  Job queue + sandboxed runner (microVM/gVisor│
                    │  ephemeral, zero-retention, file-type gated) │
                    └───────────────┬─────────────────────────────┘
          ┌─────────────────────────┼──────────────────────────────┐
          ▼                         ▼                              ▼
 ┌──────────────────┐   ┌────────────────────────┐   ┌────────────────────────┐
 │ Deterministic    │   │ Reference graph store  │   │ Finding normalizer     │
 │ engine (Matrix++)│◀─▶│ Postgres + pgvector    │   │ SARIF→canonical Finding│
 │ tree-sitter,     │   │ symbols/imports/edges  │   │ fingerprint·baseline·  │
 │ blast-radius,    │   │ + embeddings, per-repo │   │ diff-filter·dedup      │
 │ complexity, SARIF│   │ (SCIP cache per commit)│   └───────────┬────────────┘
 └──────────────────┘   └────────────────────────┘               │
                                    ┌────────────────────────────▼─────────────┐
                                    │ LLM orchestration: triage·discover·verify │
                                    │ ·explain·fix · model routing · caching     │
                                    └────────────────────────────┬─────────────┘
                                                                 ▼
            ┌──────────────┐   ┌───────────────────┐   ┌─────────────────────────┐
            │ Local CLI    │   │ Learning/memory   │   │ GitHub: 1 batched review│
            │ (same Finding│   │ pgvector per team │   │ + suggestions + neutral │
            │ model + rules│   │ addressed-comment │   │ Checks gate (non-block) │
            └──────────────┘   └───────────────────┘   └─────────────────────────┘
                    ▲
            ┌───────┴────────────────────────────────────────────┐
            │ Web dashboard + Trust Center: config, falling-FP    │
            │ metric, accept/reject, billing, SOC2/no-train/self  │
            └────────────────────────────────────────────────────┘
```

| Component | Responsibility | Tech choice |
|---|---|---|
| **Webhook & Auth** | `pull_request` (opened/synchronize/reopened/ready), `issue_comment` (@mention/slash), `pull_request_review_comment`; per-install token; track last-reviewed head SHA; one batched review + non-blocking Checks gate | **Probot + Octokit** (auth-app + throttling + retry plugins) |
| **Job queue + runner** | Debounce synchronize bursts; run pipeline in ephemeral isolated sandbox cloning base+head; zero retention | Durable workflow engine + microVM/gVisor |
| **Deterministic engine** | Tree-sitter parse, symbol/import extraction, blast-radius, dead-code, cycles, complexity/dup, SARIF collector orchestration — **fed from git diff, not FS scan** | **Matrix indexer**, ported web-tree-sitter→native + vendored grammars; store ported to Postgres |
| **Reference graph store** | Persisted per-repo symbol/import/edges + embeddings; incrementally updated on PR diff; multi-degree blast radius in **SQL, not LLM loops** | Postgres + pgvector; SCIP index cached per default-branch commit |
| **Finding normalizer** | SARIF→canonical Finding; stable fingerprints; diff-filter; baseline; dedup; suppression store | Custom single-run normalizer + reviewdog-style added-mode filter |
| **LLM orchestration** | Triage/discover/verify/explain/fix; routing; caching; line-range validation; anchor rule | Claude (cheap+frontier routing) + prompt caching, **provider-pluggable** (BYO-LLM/self-host) |
| **Learning/memory** | Capture thumbs/dismissed + first-vs-last-commit addressed signal; auto-mine rules; pgvector noise filter; **scoped local per-repo** | pgvector partitioned per team |
| **Local CLI** | `review` with plain + `--agent` JSON + interactive; staged-diff scope; `init-hooks` (husky/lefthook/pre-commit); non-blocking on error; cache by diff-hash | Single binary sharing the **canonical Finding model + ast-grep rules** with the server |
| **Web dashboard + Trust Center** | Org/repo config, falling-FP metric, accept/reject, published precision, billing, SOC2/no-train/retention/self-host | Web stack + Postgres; bill per active PR author + included reviews + transparent meter |

---

## 6. What we reuse from Matrix (the head start)

The hard, expensive thing — a multi-language deterministic code-intelligence core — **already exists** in `/Users/jow/conductor/repos/claude-matrix`.

**Lift mostly as-is** (port web-tree-sitter WASM → native, vendor+pin grammars):
- `src/indexer/languages/*` — 14 tree-sitter parsers + Template-Method `base.ts` + LRU dispatch. **Highest-value asset.**
- `src/indexer/scanner.ts` — gitignore-aware discovery (full-repo seed; PR path fed from git diff).
- `src/indexer/analysis.ts` — dead-export, orphaned-file, DFS circular-dep (rotation-dedup) + tsconfig alias resolution. *Extend `resolveImportPath` beyond TS/JS — it's currently JS-biased.*
- `src/indexer/store.ts` — `findDefinitions/findExports/searchSymbols/findCallers` (port bun:sqlite → Postgres).
- `src/db/schema.ts` — `repo_files / symbols / imports / symbol_refs`; extend with `provider/owner/name/installation_id` for multi-tenancy.
- `src/indexer/diff.ts` — mtime+sha256 model, **re-driven from git base↔head**.
- `src/repo/fingerprint.ts` — language/framework/test-framework detection → file-type tool gating.

**Replace** (Claude-Code-plugin-specific): `src/index.ts` MCP stdio server, `src/server/*` + `src/tools/*` MCP wrappers, `src/hooks/*`, local-SQLite-in-homedir assumption. Expose the core deterministic functions behind an **HTTP API** instead of MCP-over-stdio.

---

## 7. The moat

1. **A precise, persisted, multi-degree cross-file reference graph** with reproducible blast-radius / dead-code / cycle detection on PR diffs — what Matrix prototyped but left *coarse*, and what diff-only / LLM-loop competitors fake. **Real scope-aware name resolution populating `symbol_refs` is the deepest, hardest-to-copy investment.**
2. **Anchored provenance discipline** — every shipped comment has an auditable trail (SARIF result / graph edge / metric delta), enabling a structurally low FP rate *when paired with the suppression/judge layer*.
3. **A compounding per-team learning loop** keyed to the *addressed-comment* signal (the exact thing the Martian benchmark rewards) + pgvector noise filter + auto-mined rules, scoped local → the tool gets quieter and more team-shaped over time.
4. **Published reproducible precision + a public Trust Center** (SOC2, no-training, short retention, self-host) — credibility as a moat in a benchmark-fatigued, lock-in-wary market.
5. **Consistency across surfaces** — the same Finding model, ast-grep rules, and graph power the GitHub App, the CLI, and later GitLab/Bitbucket/IDE. The same finding never reappears with a different verdict.

---

## 8. Licensing matrix (resolve BEFORE architecture lock — red-team priority)

| Tool | License | Distribution mode | Verdict |
|---|---|---|---|
| tree-sitter + grammars, tags.scm | MIT | vendored/linked | ✅ Safe |
| **CodeQL CLI engine** | Proprietary; **free only for OSS** | — | ❌ **Do NOT embed** on private/commercial code |
| github/codeql **queries** | MIT | study only | ✅ Ingest the *knowledge* (sources/sinks/taxonomies), not the engine |
| **Semgrep CE engine** | LGPL-2.1 | subprocess | ⚠️ OK; **legally vet rules** — community rules mostly permissive, but Registry/Pro rules restricted + "Semgrep" is a trademark |
| ast-grep | MIT | embedded (napi/PyO3) | ✅ **Primary rule engine** |
| GritQL / Comby | MIT / Apache-2.0 | — | ➖ Not core (GritQL ~11 langs + uncertain post-acquisition; Comby non-AST, abandoned) |
| OSV.dev + osv-scanner | Apache-2.0 | API + subprocess | ✅ Safe (supply chain) |
| Grype / Syft | Apache-2.0 | subprocess | ✅ Safe |
| **gitleaks** | MIT | subprocess | ✅ Safe — **default secrets engine** |
| **trufflehog** | AGPL core (+ commercial) | subprocess | ⚠️ **AGPL-by-subprocess** — opt-in live-verification only; legal review; gitleaks-only is the safe fallback |
| SCIP + indexers (scip-*) | Apache-2.0 | subprocess (CI) | ✅ Safe — async enrichment tier |
| stack-graphs | MIT/Apache **but archived** (4 langs) | study only | ➖ Research, not a dependency |
| EPSS/KEV/CVSS feeds | public | API | ✅ Verify per-feed terms |

---

## 9. Risks & mitigations (the parts that don't survive naive optimism)

1. **Name-resolution precision is THE central risk.** Matrix "callers" are filename/symbol-name *string matches*; `symbol_refs` is unpopulated. A *wrong* blast radius wearing a deterministic halo is worse than competitor noise. → **Ship precise tiers first** (TS/JS, Python via SCIP/LSP in CI), gate every cross-file claim behind a resolution-confidence score, degrade gracefully elsewhere. **Never** emit a coarse string-match blast radius as a confident finding.
2. **SCIP can't sit on the synchronous path** (whole-project, non-incremental, needs a buildable project). → tree-sitter file-incremental on the hot path; cache last-good `index.scip` per default-branch commit; surface compiler-grade results as **async enrichment**.
3. **Latency story must be designed, not claimed.** microVM boot + clone base&head + full Semgrep + network scans lands in the same 10–20 min band we mock. → **Hard p95 < 3 min** blocking budget; everything heavier is async follow-up; warm caches by content hash.
4. **Cost/latency unbounded on large/monorepo/generated-file PRs** — blast-radius fan-out is super-linear; OSV/secret scans explode on dep bumps. → **Circuit breakers (stage 0)** + explicit degradation messaging + fan-out caps; this protects flat-fee unit economics.
5. **Anchor ≠ precision** (carried from §0). → Budget real engineering into suppression/learning + per-rule precision tuning; set an explicit precision target; measure per-rule FP from day one.
6. **Multi-language coverage is a cliff.** Deep determinism is TS/JS/Python-first; degrades to heuristics elsewhere. → Be honest internally: this is a **TS/JS/Python product first**; re-scope the breadth pitch to match, invest in Go/Java/C# scope resolution before claiming a 14-language moat.
7. **GitHub rate limits / review-API constraints.** Per-install primary (5000/hr) + secondary content-creation limits are org-shared; a monorepo synchronize burst exhausts them. → secondary-limit backoff, per-install concurrency caps, paginate/summary-only when inline-comment caps exceeded, validate against GitHub's exact positioning rules.
8. **Benchmark credibility trap.** → Use Martian internally; publish our **own** reproducible harness + falling-FP dashboard as the credibility artifact we control. Demote the (gameable) addressed-comment metric to one signal among several.
9. **LLM "determinism" is false across model versions.** → Restrict the "identical on re-run" guarantee to deterministic stages; label AI-tier comments accordingly; shard triage to avoid lost-in-the-middle.
10. **Cold-start / time-to-value.** Precision compounds over weeks. → The deterministic pre-pass must deliver **strong day-one wins** (secrets, CVEs, real cross-file breaks) that need no learning.

---

## 10. MVP — an ordered, genuinely shippable slice

Each step is independently demonstrable. **The goal of the MVP: a GitHub App that reviews a real PR end-to-end with a low-noise, anchored, fix-suggesting review — plus a local CLI that runs the same engine before commit.**

1. **GitHub App skeleton** — Probot handling `pull_request.opened/synchronize`, signature verify, per-install auth, least-privilege scopes, last-reviewed SHA tracking; a placeholder review proving the round-trip.
2. **Deterministic diff pipeline (stages 0–2)** — circuit breakers + ecosystem detect; base→head parse; `git blame` clean-as-you-code line set; tree-sitter parse of changed files only; difftastic/ast-grep noise strip.
3. **Port the Matrix core** — lift indexer/languages, scanner, analysis, store queries; port schema to Postgres; vendor+pin grammars; feed from git diff.
4. **SARIF collector layer (stage 3)** — Semgrep CE + ast-grep rules + OSV lockfile-diff + gitleaks, normalized into the canonical single-run Finding model with stable fingerprints, file-type-gated.
5. **Blast-radius v1 (stage 4) — invest here, it's the moat.** Harden Matrix name resolution to populate an `edges` table; compute single/multi-degree blast radius deterministically in SQL; surface signature/rename breaks. **Gate every claim behind a resolution-confidence score.**
6. **Filter / baseline / dedup (stage 5)** — diff-filter to changed lines; baseline so only new findings surface; fingerprint dedup; basic suppression store.
7. **LLM triage + verify + explain (stages 6 + §4)** — Qodo-style budgeted context; **sharded** low-temp triage with severity/confidence tiering + anchor rule; line-range gate; explanation + committable suggestions. Default quiet, nitpicks collapsed.
8. **Post results** — one batched `POST /pulls/{n}/reviews` with inline comments + suggestions + a **neutral** (non-blocking) Checks summary; failure reserved for high-confidence security; incremental on synchronize; never re-post dismissed comments.
9. **Local CLI v1** — `review` over the staged diff with plain + `--agent` JSON modes, sharing the same Finding model + ast-grep rules; `init-hooks` for husky/lefthook; non-blocking on error (exit 0 on network/timeout); cache by diff-hash. **LLM stays off the blocking pre-commit path by default.**
10. **Feedback & honesty loop** — thumbs/dismissed capture → per-repo suppression + pgvector noise filter; minimal dashboard showing the falling-FP rate; addressed-comment first-vs-last-commit as one eval signal, scored on the Martian methodology.

---

## 11. How we prove we're better (metrics)

- **Primary internal metric:** per-rule + overall **precision** = (comments the author acted on) / (comments posted), on a fixed multi-repo, multi-language harness (Martian methodology, our reproducible runner).
- **Public artifact:** a per-team **falling false-positive** chart in the dashboard — buyers *see* precision improve.
- **Latency SLO:** p95 < 3 min blocking; first comment < 60s where possible.
- **Determinism SLO:** identical deterministic-stage output for identical `(diff-hash, index-version, rule-version)`.
- **Guardrail:** track recall too (don't become Graphite — great precision, misses everything). Publish **both** FP and missed-bug rates.

---

## 12. Naming & surfaces

**Splus.** One engine, three surfaces:
- **`@splus` GitHub App** — auto-review on open/push or on `@splus` mention; behavior configured in the web dashboard (`profile`, path filters, `--fail-on`, severity threshold, auto vs mention).
- **`splus` CLI** — `splus review` (staged diff), `splus init-hooks`, `--agent` JSON for Claude Code/Cursor/Codex to auto-apply fixes.
- **Splus dashboard + Trust Center** — config, falling-FP metric, accept/reject training, billing, SOC2/no-train/self-host posture.

---

*Full competitive + tooling intelligence with sources: [`docs/RESEARCH.md`](docs/RESEARCH.md).*
