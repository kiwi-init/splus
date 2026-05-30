#!/usr/bin/env node
// Read a Splus JSON report on stdin and emit GitHub Actions annotations, so
// findings show up inline on the PR diff. Works on any repo (no code-scanning
// / Advanced Security needed) — these are plain workflow commands.
// Read stdin robustly (readFileSync(0) can throw EAGAIN on a pipe).
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");

let report;
try {
  report = JSON.parse(raw);
} catch {
  process.exit(0); // engine errored / no JSON — stay silent, never fail CI
}

const findings = report.findings ?? [];
const level = (s) => (s === "critical" || s === "high" ? "error" : s === "medium" ? "warning" : "notice");
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => esc(s).replace(/,/g, "%2C").replace(/:/g, "%3A");

let n = 0;
for (const f of findings) {
  const body = `${f.title} — ${f.rationale ?? f.message}` + (f.suggestion ? `\nsuggested fix:\n${f.suggestion}` : "");
  const title = `Splus: ${f.rule_id}`;
  const line = f.region?.start_line ?? 1;
  console.log(`::${level(f.severity)} file=${escProp(f.file)},line=${line},title=${escProp(title)}::${esc(body)}`);
  n++;
}
console.error(`splus: emitted ${n} inline annotation(s)`);
