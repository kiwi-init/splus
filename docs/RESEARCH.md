# Splus — Research Dossier

Competitive teardowns, deterministic-tooling deep dives, platform/GTM, and the Matrix reuse audit.
Generated from a 21-track parallel research sweep + adversarial red-team (2026-05-30). Confidence noted where live verification was partial.

---

## A. AI reviewers (competitors)

### CodeRabbit — the leader to dethrone
- **Architecture** (Google Cloud Run blog, high-confidence): lightweight webhook/billing service → Cloud Tasks queue → heavy execution service (**8 vCPU / 32GB, concurrency 8, 1h timeout, 200+ instances**) clones repo to in-memory volume, builds env, runs **40–50+ linters/SAST**, builds a cross-file/cross-repo code graph (uses **ast-grep**). Each review **10–20 min**.
- **Sandbox**: Cloud Run Gen2 microVM + gVisor + Jailkit + cgroups + per-review least-privilege IAM; zero retention.
- **Memory**: **LanceDB** vector store — tens of thousands of tables, millions of daily interactions, P99 < 1s; stores code structure, Jira/Linear tickets, historical PRs, dependency graphs, "tribal learnings"; single-binary (enables on-prem).
- **Bundled tools** (docs.coderabbit.ai/tools/list): Semgrep/OpenGrep/ast-grep, TruffleHog/Betterleaks/Presidio, OSV-Scanner/Checkov/Trivy, ESLint/Biome/Oxlint, Ruff/Pylint/Flake8, golangci-lint, Clippy, RuboCop/Brakeman, PHPStan/PHPMD, PMD/detekt, Clang-Tidy/Cppcheck, ShellCheck, SwiftLint, SQLFluff, Buf, TFLint, Hadolint, actionlint, markdownlint, LanguageTool… auto-selected by language.
- **Config** (`.coderabbit.yaml`, ~40 keys): `profile` chill(default)/assertive; `auto_review.auto_incremental_review` true; `auto_pause_after_reviewed_commits` 5; `path_filters`, `path_instructions` (≤20k chars); per-tool toggles; `knowledge_base.learnings.scope` auto/global/local; `pre_merge_checks.docstrings` threshold 80.
- **Pricing**: Free (OSS/eval, ~200 files/hr) · Lite ~$12/dev · Pro ~$24/dev (annual) / ~$30 monthly · Enterprise ~$15k/mo@500. Billed only for devs who open PRs.
- **The wound**: **NOISE.** Lychee study (28 PRs): **21% nitpick + 15% useless**; ~15% FP elsewhere. Ranked among noisiest. Latency 10–20 min.
- *Sources*: cloud.google.com/blog (Cloud Run case study); lancedb.com/blog/case-study-coderabbit; docs.coderabbit.ai/tools/list; docs.coderabbit.ai/reference/configuration.

### Greptile — highest recall, worst noise
- Full-codebase graph: tree-sitter AST → **LLM docstrings per node bottom-up** → **embed docstrings (HyDE), not raw code** → graph of call/import/dependency/usage edges. Explicitly **stores no raw code** after processing; does not self-host LLMs.
- Reviewer v3 (late 2025): agentic loop, high inference budget, multi-hop reference following + git-history check; claimed +256% upvote ratio (1.44→5.13), action rate 34.75%→59.24%, 75% lower inference cost via prompt-cache.
- **Pricing**: $30/seat incl. 50 reviews, then **$1/extra review**; Enterprise ~$15k/mo@500.
- **The wound**: worst FP profile; self-benchmark **82%→45%** when Augment re-ran independently; per-review pricing backlash; **no human approval gate**.
- **Steal**: HyDE indexing (privacy story), team-partitioned vector noise filter (suppress if cosine-similar to ≥3 downvoted — moved address rate 19%→55%), addressed-comment signal, auto-mined NL rules.

### Qodo Merge / PR-Agent — best-documented compression
- OSS core `qodo-ai/pr-agent` (Apache-2.0, Python). `PRAgent.handle_request()` routes `/review→PRReviewer`, `/describe`, `/improve`, `/ask` over a git-provider abstraction + LiteLLM.
- **Compression pipeline** (steal this): `pr_generate_extended_diff()` (≤`MAX_EXTRA_LINES=10` context) → on token overflow `pr_generate_compressed_diff()` sorts files by language priority then descending token count, strips deletion-only hunks (`handle_patch_deletions`), clips oversized patches (`clip_tokens`), reserves buffers (SOFT 1500 / HARD 1000), replaces dropped files with summary placeholders. Goal: **one LLM call per tool.**
- Self-reflection scoring 0–10 with threshold + `focus_only_on_problems` (their main FP lever). `best_practices.md` org rules + monthly auto-mined `.pr_agent_auto_best_practices`.
- **Pricing**: Free 30 PRs + 250 IDE/CLI credits · Teams $30 · Enterprise sales.
- **The wound**: diff-scoped, weak cross-file; ~25% FP; large PRs silently lose coverage; no Linear.

### Graphite Agent (Diamond) — extreme low-noise
- Precision-over-recall by design: **<5% negative-comment** (<3% unhelpful) over 500k+ PRs, "reviews in seconds." Strong eval flywheel (Braintrust writeup: thumbs + accepted/unaccepted datasets, **acceptance-rate primary metric**, line-range validity, semantic dedup).
- **The wound**: catches very few bugs (**6%** in Greptile's 50-PR benchmark — worst of field); opaque retrieval; **acquired by Cursor Dec 2025** (lock-in).
- **Pricing**: Hobby free · Starter $20 · Team $40.
- **Steal**: the eval flywheel + line-range validation gate; make precision/recall a **per-team knob** (don't pick one point).

### Platform-native (Cursor BugBot / Copilot / Gemini)
- **BugBot**: highest-precision of the three, agentic, skips style nits, claims 70%+ flags resolved pre-merge; **GitHub-only, Cursor-tethered**; → usage billing **$1–1.5/run** (June 2026).
- **Copilot review**: distribution king (PR UI, all IDEs, any language, can auto-review all org PRs); pairs with **Copilot Autofix + CodeQL** (90%+ alert coverage JS/TS/Java/Python). But shallow on complex PRs, **15–25% FP**, **re-posts dismissed comments**, reads only **first 4,000 chars** of instructions; → usage billing + 13× premium multiplier.
- **Gemini Code Assist**: misses architecture/business-logic; GitHub-focused.
- **Wedge vs platforms**: compete on **whole-repo cross-file context** (they're diff-only), **multi-platform from day one**, **never re-post dismissed comments**, **transparent flat pricing** as they all drift to opaque metering. Don't fight CodeQL on security breadth — complement it.

### Long tail
- **Korbit** ($24, "fewer FPs"), **Ellipsis** (YC W24, $20, NL custom rules + team-feedback learning + **tested fixes**, SOC2, in-memory VPC), **Bito** ($15, Claude-backed, Symbol Index + AST + embeddings, bundles fbinfer/Dependency-Check/Snyk), **CodeAnt** ($24+$20, only vendor on **all 4 Git platforms**, OWASP/CWE + **EPSS prioritization**).
- **Baz**: difftastic + tree-sitter AST diffing across 30+ langs, predicts breaking changes via call-site tracking. **Devin Review**: logical diff regrouping + copy/move detection + red/yellow/gray tiers.
- **Steal**: AST-diff noise filtering (Baz), blast-radius context selector (**~6.8× token reduction**), Ellipsis accept/reject learning, intent verification (linked ticket → flag requirement-not-implemented).

---

## B. Deterministic SAST platforms

### SonarQube / SonarQube Cloud
- **6,000–7,000+ rules / 40+ languages**; types: Bug (Reliability), Code Smell (Maintainability), Vulnerability + Security Hotspot (Security).
- Computes without any LLM: cyclomatic complexity; **Cognitive Complexity** (+1 per linear-flow break + nesting-depth penalty; switch counts once; else/else-if no nesting penalty; recursion +1; `sumOfPrimes`=7 is a ready unit test); token **duplication via suffix-tree** (default 100 tokens non-Java / 10 statements Java); **inter-procedural taint** (Sources→Passthroughs→Sanitizers→Sinks, cross-file) for SQLi/XSS/SSRF/path-traversal/deserialization.
- **Quality Gates** + **Clean as You Code** (new-code-only): default gate = 0 new issues, 100% new hotspots reviewed, ≥80% new-code coverage, ≤3% duplication.
- **Pricing**: LOC-based; free <50k private LOC; Team ~$32/mo@100k LOC.
- **Steal**: the deterministic pre-pass philosophy; replicate Cognitive Complexity exactly; suffix-tree CPD; **Clean as You Code via `git blame`**; configurable PR Quality Gate; but treat Code Smell as warning not build-breaker.

### Semgrep / Snyk Code / DeepSource / Codacy / CodeGuru / Qodana
- **SARIF 2.1.0** is the universal ingestion format (all export it; GitHub Code Scanning ingests it).
- **Semgrep** is the standout: **~2,800 CE OSS rules** (Semgrep Rules License) + 20k+ Pro rules; deterministic AST/dataflow; YAML custom rules; **cross-file taint (Pro)** claims 50–70% more TPs; free ≤10 contributors. Pricing: Teams $30/contributor/module.
- **Snyk Code** (DeepCode AI): symbolic+ML hybrid, 25M+ dataflow cases, 19+ langs, strong cross-file taint — but **closed engine**, documented FP/noise.
- **CodeGuru**: ❌ maintenance mode (no new repos since Nov 7 2025) — benchmark against **Amazon Q Developer** instead.
- **Ingest, don't re-derive**: run Semgrep CE in CI, parse SARIF; reserve LLM for what SAST can't do (IDOR/business-logic) + triage/dedup. Treat closed engines (Snyk/DeepSource AI) as lower-trust ingestion behind our LLM filter.

---

## C. Deterministic building blocks

### Name resolution: tree-sitter tags / tree-sitter-graph / stack-graphs
- **stack-graphs** (github/stack-graphs): name-binding as graph paths; **file-incremental** (each file → isolated partial-paths subgraph stitched through shared ROOT at query time; GitHub claims sub-100ms). **BUT archived 2025-09-09, only 4 languages** (Py/Java/JS/TS). → Research, not a dependency.
- **Recommended path** (the "aider way"): tree-sitter **tags.scm** (~20 langs off-the-shelf, ~100k lines/sec) for defs/refs/qualified-names; build a global graph by linking per-file defs/refs + import/export edges by symbol name; **PageRank-style ranking** for context priority. Accept ~90% import-resolution; keep multiple candidates for ambiguous symbols, disambiguate with embeddings. Optional precise tier via SCIP/LSP for TS/JS/Python.

### SCIP / LSIF (compiler-grade)
- SCIP: Protobuf batch index — definitions/references/implementations/type-definitions/hovers, **human-readable canonical symbol strings** (e.g. `scip-python python PyYAML 6.0 yaml/dump()`) → ~4–5× smaller, ~3× faster than LSIF. Indexers (scip-typescript/python/java/go/clang/ruby/dotnet, rust-analyzer) reuse real compiler frontends → **require buildable project**.
- **Use**: run in CI (where build already runs) for compiler-grade blast radius on GA languages; **cache last-good `index.scip` per default-branch commit**; **NOT on the synchronous PR path** (tens of sec–min). Consume `index.scip` directly (stable Protobuf, Go/Rust bindings) without a Sourcegraph instance. Adopt SCIP symbol-string design as our **internal canonical symbol ID** (free cross-repo joins). Treat indexers as untrusted; degrade to tree-sitter rather than emit wrong edges.

### Structural rule/rewrite engines
- **ast-grep** (MIT, Rust/tree-sitter, ~30 langs): composable YAML rules, **native SARIF**, 5 severity levels, inline-ignore suppression, embeddable (`@ast-grep/napi`, `ast-grep-py`, WASM, LSP). **CodeRabbit already uses it** + ships `ast-grep-essentials`. → **Adopt as our deterministic rule engine.**
- GritQL (MIT, ~11 langs, now under Biome post-Honeycomb) and Comby (Apache-2.0, non-AST, abandoned 2022) → not core.

### Supply chain (deterministic, free)
- **GitHub Dependency Review API**: `GET /repos/{o}/{r}/dependency-graph/compare/{base}...{head}` → added/removed deps (incl. transitive) with `change_type`, ecosystem, version, purl, license, scope, and `vulnerabilities[]` (GHSA). *Requires GHAS on private repos.*
- **OSV.dev** `POST /v1/querybatch` (P50 ≤500ms / P95 ≤6s) — platform-agnostic, free; **osv-scanner** (11+ ecosystems, 19+ lockfile types, SARIF, SPDX license allowlist).
- **Grype scoring**: rank by **CVSS + EPSS (exploit probability) + CISA KEV** — gate on this, not raw CVSS (kills alert fatigue).
- Implement **lockfile diffing** ourselves (npm/yarn/pnpm/Cargo/go.sum/poetry/Gemfile/composer); classify new-direct / new-transitive / version-bump (major→cross-yanked); license-change detection.
- **Secrets**: gitleaks (MIT) regex+entropy on the diff; opt-in trufflehog live-verification (⚠️ AGPL + outbound calls).

### Complexity & duplication metrics
- **Cognitive Complexity** as headline maintainability signal (better than cyclomatic; aggregates above function level; default threshold 15, tunable to 8).
- **The killer feature is the DELTA**: match functions base↔head, surface `cognitive 12→31 (+19)`; comment only when delta crosses threshold.
- **Be honest**: complexity↔bugs correlation ~0.05–0.15 (near noise). Frame as maintainability/review-effort, not bug prediction.
- **Duplication**: Rabin-Karp over normalized token stream (minTokens ~50–70, identifiers/literals abstracted → Type-2 clones), scoped to diff.
- **Churn × complexity hotspots** (git history) is the one signal with real defect-predictive backing (CodeScene: ~5.5% of files → ~23% of bugs) — use to **rank** which findings surface first.

### SARIF + LSP harvesting
- **SARIF 2.1.0** canonical wire format: `{version, runs[]}`, each run `tool.driver.rules[]` + `results[]` (`ruleId`, `level`, `message`, `locations[].physicalLocation.region`, `partialFingerprints`, `properties`).
- **Do NOT** ship SARIF Multitool `merge` (multi-run; GitHub stopped auto-combining 2025-07-21). Parse all SARIF into **our own canonical Finding model**, compute stable fingerprints, diff-filter to added lines.
- Run tools **only when matching file types present** in the diff (CodeRabbit's gating — biggest cost/latency win). Cache by `(tool version, config hash, file content hash)`.
- **Headless LSP** as a second deterministic source: compiler-grade diagnostics, cross-file references, `prepareRename`/rename WorkspaceEdits → rename-impact.

---

## D. Platform & GTM

### GitHub App (not OAuth)
- Fine-grained per-resource permissions, own bot identity, per-installation rate limits, **only app type that can use the Checks API**.
- **Webhooks**: `pull_request` (opened/synchronize/reopened/ready_for_review/edited — **synchronize = new commits**), `issue_comment` (PR comments arrive here w/ `pull_request` field → **@mention/slash detection**), `pull_request_review_comment` (thread replies), optional `pull_request_review`.
- **Posting**: (1) single batched **`POST /pulls/{n}/reviews`** with `comments[]` (`line`/`side`/`start_line`/`start_side`; `position` deprecated); (2) ` ```suggestion ` blocks for one-click fixes; (3) **Checks API** (`POST /check-runs`, markdown + ≤50 annotations/req) — default **`neutral`** (non-blocking), `failure` only for high-confidence security.
- **Flow**: opened/reopened/ready → full review; synchronize → **incremental** (diff since last reviewed head SHA); issue_comment → parse for `@splus` command.
- **Rate limits**: post all inline findings as **ONE** review call (UX + secondary-rate-limit mitigation); per-install primary 5000/hr + secondary content-creation limits are org-shared.
- Default to **Probot + Octokit** (auto JWT→install-token + signature verification).

### Hybrid "save inference" architecture (convergent best practice)
- Deterministic pre-pass (linters/SAST/ast-grep + code-graph) → tight context (~1:1 code:context) → LLM **triage/explain only on pre-surfaced candidates** → LLM-as-judge verify/dedup → post.
- Persistent, incrementally-updated code graph + embeddings, queried at review time for call sites/impact (catches cross-file bugs the diff hides).
- Qodo-style large-PR compression (two-phase, rank by language + descending change size, strip deletion-only, clip oversized).
- **Incremental review + dedup default** = biggest noise+latency+cost win. Never repeat an acknowledged/dismissed finding.
- **Compete on signal-to-noise, not recall** — the loudest complaints are noise/nitpicking, not missed bugs.

### Positioning & pricing
- Venture land grab: CodeRabbit ~$40M ARR / $550M val / $88M raised; Greptile $180M val; Qodo $120M raised; Graphite → Cursor.
- Converged pricing: **per-developer SaaS ~$20–30/seat/mo, billed only on PR authors** (Greptile adds $1/review overage).
- **#1 trust-killer = false positives** (Martian: best tools ~50–64% F1 / ~49–62% precision; vendor self-benchmarks discredited).
- **Enterprise table-stakes**: SOC2 Type II, "we don't train on your code" + short/zero retention, SSO/SAML, RBAC, audit logs, self-host/BYO-LLM, public Trust Center.
- **Wedge**: precision/signal; visible per-team feedback loop + falling-FP metric; honest reproducible accuracy; cross-repo/monorepo + intent-awareness.

### Local CLI DX
- Pattern across CodeRabbit/Qodo/Greptile/CodeAnt: thin client sends local diff (+context) to hosted server → severity-rated, fix-suggesting findings.
- Three output modes: **plain** (default), **`--agent`/`--prompt-only`** (structured JSON for Claude Code/Cursor/Codex to auto-apply), interactive TUI.
- **Speed = correctness**: target P50 <10s, P95 <30s on staged diff; stream findings; warm index in background.
- **Don't block pre-commit on the LLM by default**: fast local deterministic checks (secrets/lint, sub-2s) on pre-commit; LLM review on pre-push/post-commit (advisory). `--fail-on <severity>`, `--min-confidence`, exit 0/1/2 (**network/timeout → exit 0, non-blocking**).
- Native config for **husky + lefthook + pre-commit framework**; `init-hooks` auto-detects manager.
- **Cache by diff-hash + index-version** → deterministic re-runs (attacks the non-determinism complaint).

---

## E. Matrix reuse audit (our head start)

Matrix = Claude Code plugin (TypeScript/Bun v2.4.1). Reusable core = multi-language indexer on **web-tree-sitter WASM** + single local SQLite (bun:sqlite). Scans repo (Bun.Glob + .gitignore), parses **14 languages** → flat symbol/import model → 4 tables (`repo_files`, `symbols`, `imports`, `symbol_refs`). Computes blast radius (`find_callers` via import+name matching), dead code (zero-caller exports + orphaned files), circular deps (DFS).

**Critical caveat**: **taint and multi-degree transitive blast radius are NOT deterministic code** — they're LLM agent prompts in `skills/review` orchestrating the deterministic MCP tools. `symbol_refs` is **unpopulated**; `find_callers` is filename/symbol-name **string matching**.

- **REUSE (lift mostly as-is)**: `src/indexer/languages/*` (14 parsers + `base.ts` template-method + LRU dispatch — highest-value), `scanner.ts`, `analysis.ts` (dead-export/orphan/DFS-cycle + alias resolution), `store.ts` queries, `db/schema.ts` shapes, `diff.ts` (mtime+sha256), `fingerprint.ts`.
- **REPLACE**: `index.ts` MCP stdio server, `server/*`+`tools/*` MCP wrappers, all `hooks/*`, local-SQLite-in-homedir.
- **GAPS**: (1) multi-tenancy — `repoId` is a path hash → need provider+owner+name+installation_id + tenant tables; (2) persistence — bun:sqlite → **Postgres + pgvector** (replace JS cosine full-scan); (3) **incremental on PR diffs** — git-diff-driven re-parse of changed files only; (4) **name-resolution precision — the biggest engineering risk** — need real scope binding, qualified names, populate `symbol_refs`.

---

## F. Red-team — the corrections that matter

1. **Anchor ≠ precision.** SAST anchors are themselves top FP sources; the rule mostly *relabels* noise. Reframe wedge as gated/learned suppression + tiering on top of grounded candidates; measure per-rule FP from day one.
2. **Blast-radius moat is R&D, not a port.** Doesn't exist until `symbol_refs` has scope-aware binding. Ship only where SCIP/LSP-grade resolution exists (TS/JS/Python); gate every cross-file claim behind a resolution-confidence score; never emit coarse string-match blast radius confidently.
3. **Latency is self-contradictory.** microVM + clone base&head + full Semgrep + network scans = same 10–20 min band. Define hard **p95 < 3 min** blocking budget; push SCIP/live-verify/graph-rebuild to async enrichment.
4. **Add circuit breakers BEFORE deterministic stages.** Max files/bytes, generated/vendored/lockfile detection, fan-out caps; explicit degradation. Otherwise cost/latency unbounded on large/monorepo/dep-bump PRs.
5. **Build a per-tool license × distribution-mode matrix** (Semgrep CE community vs Registry/Pro + trademark; trufflehog AGPL vs MIT gitleaks; OSV/Grype/Syft; feeds; grammars). Resolve before architecture lock.
6. **Engineer for GitHub rate limits up front** (org-shared primary 5000/hr + secondary); secondary-limit backoff, per-install concurrency caps, paginate/summary-only on comment caps, exact diff-position rules.
7. **Decouple marketing from one external benchmark.** Martian internal; publish our own reproducible harness + falling-FP dashboard. Demote (gameable) addressed-comment metric to one signal.
8. **Be honest: TS/JS/Python first.** Differentiator degrades to heuristics elsewhere; re-scope breadth/GitLab/enterprise pitch or invest in Go/Java/C#/Kotlin scope resolution before claiming a 14-language moat.
9. **Redesign LLM triage to scale**: shard/batch by file/severity (avoid lost-in-the-middle on high-finding PRs). Stop claiming LLM determinism — temp 0 ≠ reproducible across versions; restrict "identical on re-run" to deterministic stages.
