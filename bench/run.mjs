#!/usr/bin/env node
/**
 * bench/run.mjs — Splus deterministic-floor REGRESSION GATE.
 *
 * This is NOT a competitive benchmark — a tool grading its own homework on cases
 * it authored proves nothing (see RESEARCH §F.7). Competitive scoring lives in
 * the Martian Code Review Bench (real PRs, human golden comments, LLM judge):
 * `bench/martian/`. This gate only guards the engine against regressions:
 *
 *   - tp     cases plant a known sink on a known line   → the floor MUST flag it
 *   - benign cases add ordinary, correct code           → the floor MUST stay SILENT
 *
 * It runs the real `splus-engine review --staged` path over temp git repos and
 * fails (exit 1) if recall drops or any benign case produces noise. Run it after
 * touching collectors/rules so a new rule can't quietly start firing on clean code.
 *
 * Usage:  node bench/run.mjs            (uses target/release/splus-engine)
 *         SPLUS_ENGINE=/path node bench/run.mjs
 *         node bench/run.mjs --json     (machine-readable summary)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ENGINE =
  process.env.SPLUS_ENGINE ||
  join(dirname(new URL(import.meta.url).pathname), "..", "target", "release", "splus-engine");
const JSON_OUT = process.argv.includes("--json");

// ── Regression thresholds (gate, not a competitive claim) ─────────────────────
const MIN_RECALL = 0.9; // the floor must catch ≥90% of planted sinks
const MAX_BENIGN_NOISE = 0; // and emit ZERO findings on benign changes

// ── Corpus ────────────────────────────────────────────────────────────────────
// Synthetic, non-real credentials assembled from fragments at runtime — so no
// contiguous key pattern lives in source (keeps secret-scanning push protection
// happy while still exercising the engine's secret detector at runtime).
const FAKE_AWS_ID = "AKIA" + "Z7XQ2MNP4RST6UVW";
const FAKE_AWS_SECRET = "wJalrXUtnFEMIbKd" + "MDENGzPxRfiCYz9aQrStUvWx";

// Each case: { name, kind, file, body, expect? }. `expect.cat` is the category a
// flag must carry to count as a true positive; `expect.line` substring locates it.
const CASES = [
  // ───────── true positives (engine MUST flag) ─────────
  { name: "aws-secret", kind: "tp", file: "cfg.py",
    body: `AWS_ACCESS_KEY_ID = "${FAKE_AWS_ID}"\nAWS_SECRET = "${FAKE_AWS_SECRET}"\n`,
    expect: { cat: "security" } },
  { name: "yaml-load", kind: "tp", file: "load.py",
    body: `import yaml\ndef parse(raw):\n    return yaml.load(raw)\n`,
    expect: { cat: "security", line: "yaml.load" } },
  { name: "pickle-loads", kind: "tp", file: "ser.py",
    body: `import pickle\ndef restore(blob):\n    return pickle.loads(blob)\n`,
    expect: { cat: "security", line: "pickle.loads" } },
  { name: "py-eval", kind: "tp", file: "ev.py",
    body: `def calc(expr):\n    return eval(expr)\n`,
    expect: { cat: "security", line: "eval(" } },
  { name: "shell-true", kind: "tp", file: "run.py",
    body: `import subprocess\ndef go(cmd):\n    subprocess.run(cmd, shell=True)\n`,
    expect: { cat: "security", line: "shell=True" } },
  { name: "sql-fstring", kind: "tp", file: "db.py",
    body: `def find(cur, uid):\n    cur.execute(f"SELECT * FROM users WHERE id={uid}")\n`,
    expect: { cat: "security", line: "execute(f" } },
  { name: "tls-verify-off", kind: "tp", file: "http.py",
    body: `import requests\ndef fetch(u):\n    return requests.get(u, verify=False)\n`,
    expect: { cat: "security", line: "verify=False" } },
  { name: "js-sql-template", kind: "tp", file: "q.ts",
    body: `export function find(db, id: string) {\n  return db.query(\`SELECT * FROM u WHERE id=\${id}\`);\n}\n`,
    expect: { cat: "security", line: "query(" } },
  { name: "dangerous-html", kind: "tp", file: "View.tsx",
    body: `export const View = ({ html }: { html: string }) =>\n  <div dangerouslySetInnerHTML={{ __html: html }} />;\n`,
    expect: { cat: "security", line: "dangerouslySetInnerHTML" } },
  { name: "merge-marker", kind: "tp", file: "m.ts",
    body: `export const x = 1;\n<<<<<<< HEAD\nexport const y = 2;\n=======\nexport const y = 3;\n>>>>>>> branch\n`,
    expect: { cat: "correctness", line: "<<<<<<<" } },
  { name: "focused-test", kind: "tp", file: "a.test.ts",
    body: `describe.only("suite", () => {\n  it("works", () => {});\n});\n`,
    expect: { cat: "correctness", line: ".only" } },
  { name: "debugger", kind: "tp", file: "d.ts",
    body: `export function f() {\n  debugger;\n  return 1;\n}\n`,
    expect: { cat: "hygiene", line: "debugger" } },

  // ───────── benign (engine MUST stay silent) ─────────
  // These are exactly where noisy reviewers fire nitpicks.
  { name: "parameterized-sql", kind: "benign", file: "db.py",
    body: `def find(cur, uid):\n    cur.execute("SELECT * FROM users WHERE id = %s", (uid,))\n    return cur.fetchone()\n` },
  { name: "yaml-safe-load", kind: "benign", file: "load.py",
    body: `import yaml\ndef parse(raw):\n    return yaml.safe_load(raw)\n` },
  { name: "argv-subprocess", kind: "benign", file: "run.py",
    body: `import subprocess\ndef go(name):\n    subprocess.run(["git", "show", name], check=True)\n` },
  { name: "specific-except", kind: "benign", file: "x.py",
    body: `def load(path):\n    try:\n        return open(path).read()\n    except FileNotFoundError:\n        return None\n` },
  { name: "structured-logging", kind: "benign", file: "svc.py",
    body: `import logging\nlog = logging.getLogger(__name__)\ndef handle(evt):\n    log.info("handling %s", evt.id)\n    return evt.id\n` },
  { name: "moderate-function", kind: "benign", file: "calc.ts",
    body: `export function classify(n: number): string {\n  if (n < 0) return "neg";\n  if (n === 0) return "zero";\n  if (n < 10) return "small";\n  if (n < 100) return "medium";\n  return "large";\n}\n` },
  { name: "normal-test", kind: "benign", file: "b.test.ts",
    body: `describe("classify", () => {\n  it("handles zero", () => { expect(classify(0)).toBe("zero"); });\n});\n` },
  { name: "react-safe", kind: "benign", file: "Card.tsx",
    body: `export const Card = ({ title }: { title: string }) =>\n  <div className="card"><h2>{title}</h2></div>;\n` },
  { name: "verified-request", kind: "benign", file: "http.py",
    body: `import requests\ndef fetch(u):\n    return requests.get(u, timeout=10)\n` },
  { name: "comment-and-const", kind: "benign", file: "k.ts",
    body: `// Maximum retries before giving up.\nexport const MAX_RETRIES = 3;\n` },
  { name: "rename-refactor", kind: "benign", file: "r.ts",
    body: `export function totalPrice(items: { price: number }[]): number {\n  return items.reduce((sum, it) => sum + it.price, 0);\n}\n` },
  { name: "json-at-boundary", kind: "benign", file: "ser.py",
    body: `import json\ndef restore(blob: str):\n    return json.loads(blob)\n` },
];

// ── Runner ────────────────────────────────────────────────────────────────────
function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), "splus-bench-"));
  try {
    const git = (...a) => spawnSync("git", a, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.email=b@b", "-c", "user.name=b", "commit", "--allow-empty", "-q", "-m", "base");
    const fp = join(dir, c.file);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, c.body);
    git("add", "-A");
    const t0 = process.hrtime.bigint();
    const out = execFileSync(ENGINE, ["review", "--root", dir, "--staged", "--format", "json"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const report = JSON.parse(out);
    return { findings: report.findings || [], ms };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Score ─────────────────────────────────────────────────────────────────────
let tpHit = 0, tpTotal = 0, benignNoise = 0, benignTotal = 0, tpFindings = 0, totalMs = 0;
const rows = [];
for (const c of CASES) {
  const { findings, ms } = runCase(c);
  totalMs += ms;
  if (c.kind === "tp") {
    tpTotal++;
    const hit = findings.some(
      (f) => f.category === c.expect.cat && (!c.expect.line || lineMatches(f, c)),
    );
    if (hit) tpHit++;
    tpFindings += findings.filter((f) => f.category === c.expect.cat).length;
    rows.push({ name: c.name, kind: "tp", result: hit ? "✓ caught" : "✗ MISSED", n: findings.length });
  } else {
    benignTotal++;
    benignNoise += findings.length;
    rows.push({
      name: c.name, kind: "benign",
      result: findings.length === 0 ? "✓ silent" : `✗ ${findings.length} NOISE`,
      n: findings.length,
    });
  }
}

function lineMatches(f, c) {
  // The engine reports the line number; we approximate by checking the planted
  // token appears in the case body at the reported line.
  const lines = c.body.split("\n");
  const ln = f.region?.start_line ?? 0;
  const text = lines[ln - 1] || "";
  return text.includes(c.expect.line);
}

const recall = tpHit / tpTotal;
const totalFindings = tpFindings + benignNoise;
const precision = totalFindings ? tpFindings / totalFindings : 1;
const noiseRate = benignNoise / benignTotal; // findings per benign change
const avgMs = totalMs / CASES.length;

const passed = recall >= MIN_RECALL && benignNoise <= MAX_BENIGN_NOISE;

if (JSON_OUT) {
  console.log(JSON.stringify({ rows, recall, precision, noiseRate, avgMs, passed }, null, 2));
  process.exit(passed ? 0 : 1);
}

const pct = (x) => (x * 100).toFixed(1) + "%";
console.log("\n  Splus deterministic-floor regression gate\n  " + "─".repeat(50));
for (const r of rows) {
  const tag = r.kind === "tp" ? "TP    " : "BENIGN";
  console.log(`  ${tag}  ${r.name.padEnd(20)}  ${r.result}`);
}
console.log("  " + "─".repeat(50));
console.log(`  recall (planted sinks caught)  ${tpHit}/${tpTotal}   ${pct(recall)}   (gate ≥ ${pct(MIN_RECALL)})`);
console.log(`  benign noise (must be 0)       ${benignNoise}`);
console.log(`  precision on corpus            ${pct(precision)}`);
console.log(`  avg latency                    ${avgMs.toFixed(1)} ms`);
console.log(`\n  regression gate: ${passed ? "✅ PASS" : "❌ FAIL"}`);
console.log("  competitive scoring → Martian bench (real PRs, LLM judge): bench/martian/\n");
process.exit(passed ? 0 : 1);
