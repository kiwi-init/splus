#!/usr/bin/env node
/**
 * calibrate.mjs — is our `claude -p` judge fair, or does it flatter Splus?
 *
 * We judge CodeRabbit's REAL comments (from the benchmark) against the same golden
 * comments with the SAME judge Splus is scored by, and compare to Martian's
 * independent verdict on CodeRabbit. If our CR score ≈ Martian's CR score, the
 * judge is calibrated — so Splus's score under it is trustworthy, and Splus-vs-CR
 * under THIS judge is a true apples-to-apples comparison.
 *
 *   node bench/martian/calibrate.mjs --repo sentry --limit 6
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const CACHE = join(HERE, ".cache");
const ROOT = join(HERE, "..", "..");
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const REPO = (flag("--repo", "sentry") || "").split(",").filter(Boolean);
const LIMIT = Number(flag("--limit", "6")) || Infinity;

const sh = (c, a) => execFileSync(c, a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
function pull(name, url) {
  mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, name);
  if (!existsSync(f)) sh("curl", ["-fsSL", "-o", f, url]);
  return JSON.parse(readFileSync(f, "utf8"));
}
const base = "https://raw.githubusercontent.com/withmartian/code-review-benchmark/main/offline/results";

const bdata = pull("benchmark_data.json", `${base}/benchmark_data.json`);
const cands = pull("candidates.json", `${base}/anthropic_claude-opus-4-5-20251101/candidates.json`);
const evals = pull("evaluations.json", `${base}/anthropic_claude-opus-4-5-20251101/evaluations.json`);

async function judge(candidates, golden) {
  const { createClaudeCliClient } = await import(join(ROOT, "packages", "triage", "dist", "index.js"));
  const client = createClaudeCliClient();
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system: [{ type: "text", text:
      "You are the judge for a code-review benchmark. Given a tool's review comments and human golden " +
      "comments (real issues), decide which golden comments the tool caught (semantic match — different " +
      "wording is fine, same underlying issue) and which tool comments matched no golden comment (noise). " +
      "Return counts; tp + fn must equal the number of golden comments." }],
    tools: [{ name: "submit_score", input_schema: { type: "object", properties: {
      tp: { type: "number" }, fp: { type: "number" }, fn: { type: "number" } }, required: ["tp", "fp", "fn"] } }],
    tool_choice: { type: "tool", name: "submit_score" },
    messages: [{ role: "user", content:
      `TOOL COMMENTS (${candidates.length}):\n` + candidates.map((c, i) => `${i + 1}. ${c}`).join("\n") +
      `\n\nGOLDEN COMMENTS (${golden.length}):\n` + golden.map((g, i) => `${i + 1}. [${g.severity}] ${g.comment}`).join("\n") +
      `\n\nReturn tp/fp/fn (tp+fn = ${golden.length}).` }],
  });
  const b = res.content.find((x) => x.type === "tool_use");
  return b?.input ?? { tp: 0, fp: candidates.length, fn: golden.length };
}

const f1 = (tp, fp, fn) => { const p = tp / (tp + fp || 1), r = tp / (tp + fn || 1); return (p + r) ? (2 * p * r) / (p + r) : 0; };

let prs = Object.entries(bdata).filter(([, v]) => REPO.some((r) => (v.source_repo || "").includes(r))).slice(0, LIMIT);
const cj = { tp: 0, fp: 0, fn: 0 }, mj = { tp: 0, fp: 0, fn: 0 };
console.log(`\n  Judge calibration — CodeRabbit, claude judge vs Martian judge\n  ${"─".repeat(58)}`);
console.log("  PR".padEnd(34) + "claude(tp/fp/fn)   martian(tp/fp/fn)");
for (const [url, pr] of prs) {
  const cr = (cands[url] || {}).coderabbit;
  const m = (evals[url] || {}).coderabbit;
  if (!cr || !m || m.skipped) { console.log(`  ${pr.source_repo.padEnd(20)} (no CR data)`); continue; }
  const golden = pr.golden_comments || [];
  const c = await judge(cr.map((x) => x.text || x), golden);
  cj.tp += c.tp; cj.fp += c.fp; cj.fn += c.fn;
  mj.tp += m.tp; mj.fp += m.fp; mj.fn += m.fn;
  console.log(`  ${pr.source_repo.padEnd(20)} ${`${c.tp}/${c.fp}/${c.fn}`.padEnd(18)} ${m.tp}/${m.fp}/${m.fn}`);
}
console.log("  " + "─".repeat(58));
console.log(`  CodeRabbit F1 — claude judge:  ${(f1(cj.tp, cj.fp, cj.fn) * 100).toFixed(1)}%   (P${(cj.tp/(cj.tp+cj.fp||1)*100).toFixed(0)}/R${(cj.tp/(cj.tp+cj.fn||1)*100).toFixed(0)})`);
console.log(`  CodeRabbit F1 — Martian judge: ${(f1(mj.tp, mj.fp, mj.fn) * 100).toFixed(1)}%   (P${(mj.tp/(mj.tp+mj.fp||1)*100).toFixed(0)}/R${(mj.tp/(mj.tp+mj.fn||1)*100).toFixed(0)})`);
const delta = Math.abs(f1(cj.tp, cj.fp, cj.fn) - f1(mj.tp, mj.fp, mj.fn)) * 100;
console.log(`\n  judges agree within ${delta.toFixed(1)} pts on CodeRabbit → ${delta < 12 ? "✅ calibrated" : "⚠️  divergent (treat splus number with caution)"}`);
console.log(`  → Splus (this judge) vs CodeRabbit (this judge) is the apples-to-apples comparison.\n`);
