#!/usr/bin/env node
/**
 * `splus` — the local CLI. Thin client over the deterministic Rust engine.
 * Review before you commit; emit agent-consumable JSON; install git hooks.
 *
 * Exit codes: 0 = clean/advisory · 1 = blocking findings (--fail-on) ·
 * 2 = tool/engine error (treated as NON-blocking by the installed hooks).
 */
import { Command } from "commander";
import {
  exceedsThreshold,
  runEngine,
  severityRank,
  type DiffMode,
  type Finding,
  type Report,
  type Severity,
} from "@splus/shared";
import { triage, type TriagedFinding, type TriagedReport } from "@splus/triage";
import {
  applySuppression,
  candidateText,
  FileSuppressionStore,
  type SuppressedFinding,
} from "@splus/suppression";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const program = new Command();
program
  .name("splus")
  .description("Splus — precision-first code review, locally and in CI")
  .version("0.1.0");

interface ReviewOpts {
  root: string;
  staged?: boolean;
  base?: string;
  json?: boolean;
  agent?: boolean;
  failOn?: string;
  color: boolean;
  llm?: boolean;
  thorough?: boolean;
  learn?: boolean;
}

program
  .command("review")
  .description("Review the current change (staged, working, or base..HEAD)")
  .option("--root <dir>", "repository root", ".")
  .option("--staged", "review staged changes (pre-commit)")
  .option("--base <ref>", "review against a base ref (PR-style)")
  .option("--json", "emit the raw engine JSON report")
  .option("--agent", "emit compact JSON for an AI agent to apply fixes")
  .option("--fail-on <severity>", "exit 1 if a finding is at/above this severity")
  .option("--llm", "triage findings with the LLM layer (needs ANTHROPIC_API_KEY)")
  .option("--thorough", "with --llm, also run the discovery pass (frontier model)")
  .option("--no-learn", "ignore the learned suppression store for this run")
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: ReviewOpts) => {
    const mode = toMode(opts);

    let report: Report;
    try {
      report = await runEngine({ root: opts.root, mode });
    } catch (e) {
      process.stderr.write(`splus: ${String(e)}\n`);
      process.exit(2);
    }

    // Learned suppression (on by default): drop findings the team already
    // dismissed (exact, rule-mute, or semantically similar). Best-effort.
    let suppressed: SuppressedFinding[] = [];
    if (opts.learn !== false) {
      try {
        const store = new FileSuppressionStore(learningsPath(opts.root));
        const r = await applySuppression(report, store);
        report = withFindings(report, r.kept, r.suppressed.length);
        suppressed = r.suppressed;
      } catch {
        /* never block a review on the suppression store */
      }
    }

    if (opts.llm) {
      await reviewWithLlm(opts, report);
      return;
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      finish(report, opts);
    }
    if (opts.agent) {
      process.stdout.write(JSON.stringify(toAgent(report), null, 2) + "\n");
      finish(report, opts);
    }
    process.stdout.write(renderDeterministicPretty(report, suppressed, opts.color));
    finish(report, opts);
  });

program
  .command("init-hooks")
  .description("Install a pre-commit hook that runs Splus (husky/lefthook/pre-commit)")
  .option("--root <dir>", "repository root", ".")
  .option("--fail-on <severity>", "severity that blocks the commit", "high")
  .action((opts: { root: string; failOn: string }) => {
    initHooks(opts.root, opts.failOn);
  });

program
  .command("dismiss <fingerprint>")
  .description("Teach Splus to stop flagging a specific finding (by its id)")
  .option("--root <dir>", "repository root", ".")
  .option("--staged", "look up the finding in staged changes")
  .option("--base <ref>", "look up the finding against a base ref")
  .action(async (fingerprint: string, opts: { root: string; staged?: boolean; base?: string }) => {
    const mode: DiffMode = opts.base
      ? { kind: "base", ref: opts.base }
      : opts.staged
        ? { kind: "staged" }
        : { kind: "working" };
    const store = new FileSuppressionStore(learningsPath(opts.root));
    let found: Finding | undefined;
    try {
      const report = await runEngine({ root: opts.root, mode });
      found = report.findings.find((f) => f.id === fingerprint);
    } catch {
      /* fall through to exact-only dismissal */
    }
    await store.record({
      fingerprint,
      rule_id: found?.rule_id ?? "unknown",
      text: found ? candidateText(found) : "",
      scope: "fingerprint",
    });
    console.log(
      found
        ? `Dismissed ${fingerprint} (${found.rule_id}). Splus won't flag it (or close variants) again on this repo.`
        : `Dismissed ${fingerprint} (exact match only — not found in the current diff).`,
    );
  });

program
  .command("mute <ruleId>")
  .description("Mute an entire rule for this repo (e.g. hygiene.python-print)")
  .option("--root <dir>", "repository root", ".")
  .action(async (ruleId: string, opts: { root: string }) => {
    const store = new FileSuppressionStore(learningsPath(opts.root));
    await store.record({ fingerprint: "", rule_id: ruleId, text: ruleId, scope: "rule", signal: "muted" });
    console.log(`Muted rule '${ruleId}' for this repo. Splus will stop flagging it.`);
  });

program
  .command("learnings")
  .description("List what Splus has learned to suppress on this repo")
  .option("--root <dir>", "repository root", ".")
  .action(async (opts: { root: string }) => {
    const store = new FileSuppressionStore(learningsPath(opts.root));
    const entries = await store.list();
    if (!entries.length) {
      console.log("No learnings yet. Use `splus dismiss <id>` or `splus mute <rule>`.");
      return;
    }
    for (const e of entries) {
      const head = e.scope === "rule" ? `[rule] ${e.rule_id}` : `[fp]   ${e.fingerprint} (${e.rule_id})`;
      console.log(`${head}  — ${e.signal} ${e.at}`);
    }
  });

program.parseAsync().catch((e) => {
  process.stderr.write(`splus: ${String(e)}\n`);
  process.exit(2);
});

// --- helpers ---------------------------------------------------------------

function toMode(opts: ReviewOpts): DiffMode {
  if (opts.base) return { kind: "base", ref: opts.base };
  if (opts.staged) return { kind: "staged" };
  return { kind: "working" };
}

function toAgent(r: Report) {
  return {
    summary: {
      findings: r.summary.findings_total,
      mustFix: r.summary.must_fix,
      concern: r.summary.concern,
      nit: r.summary.nit,
      notes: r.summary.notes,
    },
    findings: r.findings.map((f) => ({
      file: f.file,
      line: f.region.start_line,
      severity: f.severity,
      tier: f.tier,
      ruleId: f.rule_id,
      title: f.title,
      message: f.message,
      suggestion: f.suggestion ?? null,
      confidence: f.confidence,
      blastRadius: f.blast_radius
        ? {
            directCallers: f.blast_radius.direct_callers,
            transitiveCallers: f.blast_radius.transitive_callers,
            filesAffected: f.blast_radius.files_affected,
            resolutionConfidence: f.blast_radius.resolution_confidence,
          }
        : null,
    })),
  };
}

async function reviewWithLlm(opts: ReviewOpts, report: Report): Promise<void> {
  let triaged: TriagedReport;
  try {
    // The LLM only sees candidates that survived deterministic suppression.
    triaged = await triage(report, { root: opts.root, thorough: opts.thorough });
  } catch (e) {
    // Precision-first, but never block on the LLM being unavailable: fall back
    // to the (already suppression-filtered) deterministic findings.
    process.stderr.write(
      `splus: LLM triage unavailable (${String(e)}). Falling back to deterministic findings.\n`,
    );
    process.stdout.write(renderDeterministicPretty(report, [], opts.color));
    finish(report, opts);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(triaged, null, 2) + "\n");
  } else if (opts.agent) {
    process.stdout.write(JSON.stringify(toAgentTriaged(triaged), null, 2) + "\n");
  } else {
    process.stdout.write(renderTriagedPretty(triaged, opts.color));
  }

  if (opts.failOn) {
    const t = severityRank(opts.failOn as Severity);
    if (triaged.findings.some((f) => severityRank(f.severity) >= t)) process.exit(1);
  }
  process.exit(0);
}

function finish(report: Report, opts: ReviewOpts): never {
  if (opts.failOn && exceedsThreshold(report, opts.failOn as Severity)) process.exit(1);
  process.exit(0);
}

function learningsPath(root: string): string {
  return join(root, ".splus-cache", "learnings.json");
}

function withFindings(report: Report, kept: Finding[], suppressedCount: number): Report {
  const count = (t: string) => kept.filter((f) => f.tier === t).length;
  return {
    ...report,
    findings: kept,
    summary: {
      ...report.summary,
      findings_total: kept.length,
      must_fix: count("must-fix"),
      concern: count("concern"),
      nit: count("nit"),
      suppressed: suppressedCount,
    },
  };
}

function renderDeterministicPretty(report: Report, suppressed: SuppressedFinding[], color: boolean): string {
  const paint = (c: string, s: string) => (color ? `\x1b[${c}m${s}\x1b[0m` : s);
  const dim = (s: string) => paint("2", s);
  const bold = (s: string) => paint("1", s);
  const dot: Record<string, string> = {
    critical: paint("31;1", "●"), high: paint("31", "●"), medium: paint("33", "●"),
    low: paint("36", "○"), info: paint("2", "○"),
  };
  const s = report.summary;
  const out: string[] = [];
  out.push(bold("\n  Splus") + dim(` v${report.version}\n`));
  out.push(dim(`  ${s.files_changed} file(s) · ${s.added_lines} added line(s) · clean-as-you-code\n`));
  out.push(dim(`  ${"─".repeat(60)}\n`));
  if (report.findings.length === 0) out.push(paint("32", "\n  ✓ No issues on changed lines.\n"));
  for (const tier of ["must-fix", "concern", "nit"]) {
    const group = report.findings.filter((f) => f.tier === tier);
    if (!group.length) continue;
    const code = tier === "must-fix" ? "31;1" : tier === "concern" ? "33" : "36";
    out.push(`\n  ${bold(paint(code, tier))}\n`);
    for (const f of group) {
      out.push(`  ${dot[f.severity] ?? "•"} ${bold(f.title)} ${dim(`[${f.rule_id}]`)}\n`);
      out.push(dim(`      ${f.file}:${f.region.start_line}  ·  ${Math.round(f.confidence * 100)}% confidence  ·  ${f.anchor.detail}\n`));
      out.push(`      ${f.message}\n`);
      if (f.blast_radius) {
        out.push(paint("35", `      ⮑ blast radius: ${f.blast_radius.direct_callers} direct caller(s) across ${f.blast_radius.files_affected.length} file(s) · ${Math.round(f.blast_radius.resolution_confidence * 100)}% res. confidence\n`));
      }
      if (f.suggestion) out.push(paint("32", `      fix: ${f.suggestion}\n`));
    }
  }
  out.push(dim(`\n  ${"─".repeat(60)}\n`));
  out.push(`  ${paint("31;1", String(s.must_fix))} must-fix · ${paint("33", String(s.concern))} concern · ${paint("36", String(s.nit))} nit\n`);
  if (suppressed.length > 0) {
    out.push(dim(`  ${suppressed.length} suppressed by learnings (`));
    const kinds = suppressed.reduce<Record<string, number>>((a, x) => ((a[x.suppressionKind ?? "?"] = (a[x.suppressionKind ?? "?"] ?? 0) + 1), a), {});
    out.push(dim(Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(", ") + ")\n"));
  }
  for (const note of s.notes) out.push(paint("33", `  ⚠ ${note}\n`));
  out.push("\n");
  return out.join("");
}

function toAgentTriaged(t: TriagedReport) {
  return {
    summary: {
      totalKept: t.findings.length,
      ...t.llm,
    },
    findings: t.findings.map((f) => ({
      file: f.file,
      line: f.region.start_line,
      severity: f.severity,
      tier: f.tier,
      ruleId: f.rule_id,
      title: f.title,
      rationale: f.rationale,
      confidence: f.llmConfidence,
      suggestion: f.suggestion ?? null,
      llmOnly: f.llmOnly ?? false,
    })),
    suppressed: t.suppressed.map((f) => ({
      file: f.file,
      line: f.region.start_line,
      ruleId: f.rule_id,
      reason: f.rationale,
    })),
  };
}

function renderTriagedPretty(t: TriagedReport, color: boolean): string {
  const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s: string) => paint("2", s);
  const bold = (s: string) => paint("1", s);
  const dot: Record<string, string> = {
    critical: paint("31;1", "●"),
    high: paint("31", "●"),
    medium: paint("33", "●"),
    low: paint("36", "○"),
    info: paint("2", "○"),
  };

  const out: string[] = [];
  out.push(bold(`\n  Splus · LLM review`) + dim(` (${t.llm.triageModel})\n`));
  out.push(dim(`  ${t.summary.files_changed} file(s) · ${t.findings.length} kept · ${t.suppressed.length} suppressed\n`));
  out.push(dim(`  ${"─".repeat(60)}\n`));

  if (t.findings.length === 0) {
    out.push(paint("32", "\n  ✓ Nothing a senior reviewer would flag.\n"));
  }
  for (const f of t.findings as TriagedFinding[]) {
    out.push(
      `  ${dot[f.severity] ?? "•"} ${bold(f.title)} ${dim(`[${f.rule_id}]`)}${f.llmOnly ? paint("35", " (discovered)") : ""}\n`,
    );
    out.push(dim(`      ${f.file}:${f.region.start_line}  ·  ${Math.round(f.llmConfidence * 100)}% confidence\n`));
    out.push(`      ${f.rationale}\n`);
    if (f.suggestion) out.push(paint("32", `      fix:\n${f.suggestion.split("\n").map((l) => "        " + l).join("\n")}\n`));
  }

  out.push(dim(`\n  ${"─".repeat(60)}\n`));
  if (t.suppressed.length > 0) {
    out.push(dim(`  suppressed by LLM (low signal): ${t.suppressed.length}\n`));
    for (const f of t.suppressed.slice(0, 8)) {
      out.push(dim(`    - ${f.file}:${f.region.start_line} ${f.rule_id} — ${f.rationale}\n`));
    }
  }
  out.push(
    dim(
      `  tokens: ${t.llm.inputTokens} in (${t.llm.cachedInputTokens} cached) / ${t.llm.outputTokens} out\n`,
    ),
  );
  if (t.llm.discovered > 0) out.push(dim(`  discovered by frontier pass: ${t.llm.discovered}\n`));
  out.push("\n");
  return out.join("");
}

// Function declaration (hoisted) so it's safe to call from the command action,
// which runs during program.parseAsync() before module-level consts initialize.
function hookBody(failOn: string): string {
  return `#!/bin/sh
# Splus pre-commit review. Blocks on findings at/above '${failOn}'.
# Non-blocking on engine/network error (exit 2) so commits never wedge.
splus review --staged --fail-on ${failOn}
code=$?
if [ "$code" = "2" ]; then
  echo "splus: skipped (engine unavailable) — commit allowed"
  exit 0
fi
exit $code
`;
}

function initHooks(root: string, failOn: string) {
  const has = (p: string) => existsSync(join(root, p));

  // lefthook
  if (has("lefthook.yml") || has("lefthook.yaml")) {
    console.log(
      [
        "Detected lefthook. Add this to lefthook.yml:",
        "",
        "pre-commit:",
        "  commands:",
        "    splus:",
        "      run: splus review --staged --fail-on " + failOn,
        "",
      ].join("\n"),
    );
    return;
  }

  // pre-commit framework
  if (has(".pre-commit-config.yaml")) {
    console.log(
      [
        "Detected the pre-commit framework. Add this repo hook:",
        "",
        "  - repo: local",
        "    hooks:",
        "      - id: splus",
        "        name: Splus review",
        "        entry: splus review --staged --fail-on " + failOn,
        "        language: system",
        "        pass_filenames: false",
        "",
      ].join("\n"),
    );
    return;
  }

  // husky (or default): write .husky/pre-commit
  const huskyDir = join(root, ".husky");
  if (!existsSync(huskyDir)) mkdirSync(huskyDir, { recursive: true });
  const hookPath = join(huskyDir, "pre-commit");
  let existing = "";
  if (existsSync(hookPath)) existing = readFileSync(hookPath, "utf8");
  if (existing.includes("splus review")) {
    console.log("Splus hook already present in .husky/pre-commit.");
    return;
  }
  writeFileSync(hookPath, hookBody(failOn), { mode: 0o755 });
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* best-effort */
  }
  console.log(
    [
      `Wrote ${hookPath} (blocks on '${failOn}', non-blocking on engine error).`,
      "If you don't already use husky: `npx husky init` and ensure hooks are enabled.",
    ].join("\n"),
  );
}
