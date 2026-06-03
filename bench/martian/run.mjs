#!/usr/bin/env node
/**
 * bench/martian/run.mjs — score Splus on the independent Martian Code Review Bench.
 *
 * This is the REAL scoreboard (not bench/run.mjs, which is just a regression gate):
 * 50 real PRs from 5 OSS projects, human-curated golden comments, and the same
 * judging other tools were scored with. CodeRabbit sits at F1 35% (P26/R56); bare
 * Claude Code at 38%. The bar for "30% better than CodeRabbit" is F1 ≥ 46%.
 *
 * Pipeline, per PR:
 *   1. fetch the PR diff (`gh pr diff`) + reconstruct a reviewable git state
 *      (base blobs + `git apply`), so Splus runs on exactly the changed lines.
 *   2. run Splus — the deterministic floor always; the multi-pass agent review
 *      (detect→impact→triage→remediate→verify) when ANTHROPIC_API_KEY is set.
 *   3. (--judge, needs key) an LLM judge semantically matches Splus's candidates to
 *      the golden comments → per-PR precision/recall, then micro-averaged F1.
 *
 * Without a key it still runs end-to-end on the deterministic floor and reports
 * what it produced — but it CANNOT produce the headline F1 (the golden comments are
 * reasoning bugs that need the agent pass, and matching needs the semantic judge).
 * The final number is intentionally key-gated: no key, no claim.
 *
 *   node bench/martian/run.mjs --limit 1                 # smoke test (floor only)
 *   node bench/martian/run.mjs --repo cal.com,sentry     # Splus's TS/Python strength
 *   ANTHROPIC_API_KEY=... node bench/martian/run.mjs --judge   # the real head-to-head
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const HERE_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE_DIR, "..", "..");
const ENGINE = process.env.SPLUS_ENGINE || join(ROOT, "target", "release", "splus-engine");
const CACHE = join(HERE_DIR, ".cache");
const BENCH_DATA_URL =
  "https://raw.githubusercontent.com/withmartian/code-review-benchmark/main/offline/results/benchmark_data.json";
const CODERABBIT_F1 = 0.352;
const TARGET_F1 = 0.458; // CodeRabbit × 1.30

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const LIMIT = Number(flag("--limit", "0")) || Infinity;
const REPO_FILTER = (flag("--repo", "") || "").split(",").filter(Boolean);
const JUDGE = args.includes("--judge");
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
function hasClaudeCli() {
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
// LLM backend: an API key → Anthropic SDK; otherwise the local `claude -p` CLI
// (this machine's existing Claude auth) → no key, no separate billing.
const USE_CLI = !HAS_KEY && hasClaudeCli();
const HAS_LLM = HAS_KEY || USE_CLI;
const BACKEND = HAS_KEY ? "anthropic-sdk" : USE_CLI ? "claude -p" : "none";
async function llmClient() {
  const t = await import(join(ROOT, "packages", "triage", "dist", "index.js"));
  return USE_CLI ? t.createClaudeCliClient() : t.createLLMClient();
}

const sh = (cmd, a, opts = {}) =>
  execFileSync(cmd, a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

function pullBenchmarkData() {
  mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, "benchmark_data.json");
  if (!existsSync(f)) {
    process.stderr.write("pulling benchmark_data.json (one-time)…\n");
    sh("curl", ["-fsSL", "-o", f, BENCH_DATA_URL]);
  }
  return JSON.parse(readFileSync(f, "utf8"));
}

const api = (path) => JSON.parse(sh("gh", ["api", path]));
const BINARY = /\.(gz|zip|png|jpg|jpeg|gif|ico|pdf|woff2?|ttf|eot|lock|snap|map)$|install-state|\.min\./i;

/** Fetch a file's content at a ref, or null (missing / binary / too large). */
function contentAt(repo, path, ref) {
  try {
    const r = api(`repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${ref}`);
    if (r.encoding !== "base64" || r.size > 400_000) return null;
    const buf = Buffer.from(r.content.replace(/\n/g, ""), "base64");
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Reconstruct a reviewable git repo for a PR and stage exactly its changes —
 * by materializing base (at the merge-base) and head (at the head SHA) content
 * for each changed file. No `git apply` (merge-base drift + binaries make patches
 * unreliable on real PRs); the staged base→head diff IS the PR's change set.
 */
function reconstruct(prUrl, dir) {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error("unparseable PR url");
  const [, owner, repo, number] = m;
  const meta = api(`repos/${owner}/${repo}/pulls/${number}`);
  if (meta.changed_files > 60) throw new Error(`skip: ${meta.changed_files} files changed`);
  const headRepo = meta.head?.repo?.full_name;
  if (!headRepo) throw new Error("head repo gone (fork deleted)");
  const headSha = meta.head.sha;
  const cmp = api(`repos/${owner}/${repo}/compare/${meta.base.sha}...${headSha}`);
  const mergeBase = cmp.merge_base_commit?.sha ?? meta.base.sha;

  const fileList = api(`repos/${owner}/${repo}/pulls/${number}/files?per_page=100`)
    .filter((f) => !BINARY.test(f.filename));

  const git = (...a) => sh("git", a, { cwd: dir });
  git("init", "-q");
  // Base commit: each changed file's pre-PR content.
  const reviewable = [];
  for (const f of fileList) {
    if (f.status === "added") continue;
    const prev = f.previous_filename || f.filename;
    const base = contentAt(meta.base.repo.full_name, prev, mergeBase);
    if (base == null) continue;
    writeFileTo(dir, f.previous_filename || f.filename, base);
  }
  git("add", "-A");
  git("-c", "user.email=b@b", "-c", "user.name=b", "commit", "-q", "--allow-empty", "-m", "base");
  // Head: stage each changed file's post-PR content. Staged diff = the PR.
  for (const f of fileList) {
    if (f.status === "removed") {
      try { sh("git", ["rm", "-q", "--ignore-unmatch", f.filename], { cwd: dir }); } catch { /* */ }
      continue;
    }
    const head = contentAt(headRepo, f.filename, headSha);
    if (head == null) continue;
    if (f.previous_filename && f.previous_filename !== f.filename) {
      try { sh("git", ["rm", "-q", "--ignore-unmatch", f.previous_filename], { cwd: dir }); } catch { /* */ }
    }
    writeFileTo(dir, f.filename, head);
    reviewable.push(f.filename);
  }
  git("add", "-A");
  if (reviewable.length === 0) throw new Error("no reviewable text files");
  return reviewable;
}

function writeFileTo(dir, path, content) {
  const fp = join(dir, path);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, content);
}

function runSplusFloor(dir, files) {
  const out = sh(ENGINE, ["review", "--root", dir, "--staged", "--format", "json"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const report = JSON.parse(out);
  return (report.findings || []).map((f) => ({
    file: f.file,
    line: f.region?.start_line ?? 0,
    severity: f.severity,
    title: f.title,
    rationale: f.message,
    source: "floor",
  }));
}

async function runSplusAgent(dir, files) {
  // The multi-pass agent review (detect→impact→triage→remediate→verify) via
  // @splus/triage, backed by the SDK or `claude -p`.
  const { triage } = await import(join(ROOT, "packages", "triage", "dist", "index.js"));
  const { runEngine } = await import(join(ROOT, "packages", "shared", "dist", "index.js"));
  const report = await runEngine({ root: dir, mode: { kind: "staged" } });
  const diff = sh("git", ["diff", "--cached"], { cwd: dir });
  const client = await llmClient();
  const t = await triage(report, { root: dir, thorough: true, verify: true, changedFiles: files, diff, client });
  return t.findings.map((f) => ({
    file: f.file,
    line: f.region?.start_line ?? 0,
    severity: f.severity,
    title: f.title,
    rationale: f.rationale || f.message,
    source: f.llmOnly ? "agent" : "floor",
  }));
}

// --- persistence: checkpoint each scored PR so a mid-run cut never loses work ---
const RESULTS_DIR = join(HERE_DIR, "results");
const JUDGE_MODEL = process.env.SPLUS_JUDGE_MODEL || "claude-opus-4-8";
const RESULTS = join(RESULTS_DIR, `splus__${JUDGE_MODEL.replace(/[^\w.-]/g, "_")}.jsonl`);

function loadResults() {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function appendResult(row) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(RESULTS, JSON.stringify(row) + "\n");
}

async function main() {
  const data = pullBenchmarkData();
  let prs = Object.entries(data);
  if (REPO_FILTER.length) prs = prs.filter(([, v]) => REPO_FILTER.some((r) => (v.source_repo || "").includes(r)));

  // Resume: replay prior results, skip already-scored PRs. Only fully-scored PRs
  // are persisted, so a rate-limit / kill mid-PR just leaves it for the next run.
  const prior = loadResults();
  const done = new Set(prior.map((r) => r.url));
  const micro = { tp: 0, fp: 0, fn: 0 };
  for (const r of prior) if (r.scored) { micro.tp += r.scored.tp; micro.fp += r.scored.fp; micro.fn += r.scored.fn; }
  const todo = prs.filter(([url]) => !done.has(url));

  process.stderr.write(
    `Splus on Martian: ${done.size} done · ${todo.length} to go · this run ≤${LIMIT === Infinity ? "all" : LIMIT}` +
      ` · backend ${BACKEND} · judge ${JUDGE && HAS_LLM ? "ON" : "OFF"} · results → ${RESULTS}\n`,
  );

  let newly = 0;
  for (const [url, pr] of todo) {
    if (newly >= LIMIT) break;
    const dir = mkdtempSync(join(tmpdir(), "splus-martian-"));
    try {
      const files = reconstruct(url, dir);
      const candidates = HAS_LLM ? await runSplusAgent(dir, files) : runSplusFloor(dir, files);
      const golden = pr.golden_comments || [];
      const scored = JUDGE && HAS_LLM ? await judge(candidates, golden) : null;
      if (scored) {
        // Persist immediately (checkpoint) — candidates kept for later display.
        appendResult({ url, repo: pr.source_repo, judge: JUDGE_MODEL, golden: golden.length, candidates, scored, at: new Date().toISOString() });
        micro.tp += scored.tp; micro.fp += scored.fp; micro.fn += scored.fn;
        done.add(url); newly++;
      }
      process.stderr.write(
        `  ✓ ${pr.source_repo.padEnd(20)} cand=${candidates.length} golden=${golden.length}` +
          (scored ? ` tp=${scored.tp} fp=${scored.fp} fn=${scored.fn}` : " (not judged)") + "\n",
      );
    } catch (e) {
      // Not persisted → retried on the next run (this is how we survive rate limits).
      process.stderr.write(`  ⊘ ${pr.source_repo}: ${String(e.message || e).slice(0, 90)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  reportAggregate(done.size, micro);
}

function reportAggregate(scoredPRs, micro) {
  console.log("\n  Splus · Martian Code Review Bench  (cumulative across all runs)");
  console.log("  " + "─".repeat(52));
  console.log(`  PRs scored          ${scoredPRs}   (backend: ${BACKEND})`);
  if (micro.tp + micro.fp + micro.fn > 0) {
    const p = micro.tp / (micro.tp + micro.fp || 1);
    const r = micro.tp / (micro.tp + micro.fn || 1);
    const f1 = p + r ? (2 * p * r) / (p + r) : 0;
    console.log(`  precision           ${(p * 100).toFixed(1)}%`);
    console.log(`  recall              ${(r * 100).toFixed(1)}%`);
    console.log(`  F1                  ${(f1 * 100).toFixed(1)}%`);
    console.log(`\n  vs CodeRabbit F1 ${(CODERABBIT_F1 * 100).toFixed(0)}%  ·  target ≥${(TARGET_F1 * 100).toFixed(0)}%`);
    console.log(`  ≥30% better than CodeRabbit:  ${f1 >= TARGET_F1 ? "✅ YES" : "❌ not yet"}`);
  }
  console.log("");
}

/** LLM judge: does each golden comment have a matching Splus candidate? (needs key) */
async function judge(candidates, golden) {
  const client = await llmClient();
  const sys =
    "You are the judge for a code-review benchmark. Given a tool's review comments and a set of " +
    "human golden comments (real issues), decide which golden comments the tool actually caught " +
    "(semantic match — different wording is fine, same underlying issue), and which tool comments " +
    "matched no golden comment (noise). Return counts.";
  const tool = {
    name: "submit_score",
    description: "Submit the match counts.",
    input_schema: {
      type: "object",
      properties: {
        tp: { type: "number", description: "golden comments the tool caught" },
        fp: { type: "number", description: "tool comments matching no golden comment" },
        fn: { type: "number", description: "golden comments the tool missed" },
      },
      required: ["tp", "fp", "fn"],
    },
  };
  const body = {
    model: process.env.SPLUS_JUDGE_MODEL || "claude-opus-4-8",
    max_tokens: 1024,
    system: [{ type: "text", text: sys }],
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_score" },
    messages: [
      {
        role: "user",
        content:
          `TOOL COMMENTS (${candidates.length}):\n` +
          candidates.map((c, i) => `${i + 1}. [${c.severity}] ${c.title} — ${c.rationale} (${c.file}:${c.line})`).join("\n") +
          `\n\nGOLDEN COMMENTS (${golden.length}):\n` +
          golden.map((g, i) => `${i + 1}. [${g.severity}] ${g.comment}`).join("\n") +
          `\n\nReturn tp/fp/fn. Note tp + fn must equal ${golden.length}.`,
      },
    ],
  };
  const res = await client.messages.create(body);
  const block = res.content.find((b) => b.type === "tool_use");
  const out = block?.input ?? { tp: 0, fp: candidates.length, fn: golden.length };
  return { tp: out.tp ?? 0, fp: out.fp ?? 0, fn: out.fn ?? 0 };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
