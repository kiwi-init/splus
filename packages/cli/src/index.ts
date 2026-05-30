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
  runEnginePretty,
  type DiffMode,
  type Report,
  type Severity,
} from "@splus/shared";
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
  .option("--no-color", "disable ANSI colors")
  .action(async (opts: ReviewOpts) => {
    const mode = toMode(opts);

    // Structured output paths capture + transform engine JSON.
    if (opts.json || opts.agent) {
      try {
        const report = await runEngine({ root: opts.root, mode });
        process.stdout.write(
          JSON.stringify(opts.agent ? toAgent(report) : report, null, 2) + "\n",
        );
        if (opts.failOn && exceedsThreshold(report, opts.failOn as Severity)) {
          process.exit(1);
        }
        process.exit(0);
      } catch (e) {
        process.stderr.write(`splus: ${String(e)}\n`);
        process.exit(2); // engine error → non-blocking by convention
      }
    }

    // Default: stream the engine's pretty output and propagate its exit code.
    const code = await runEnginePretty({
      root: opts.root,
      mode,
      failOn: opts.failOn,
      noColor: !opts.color,
    });
    process.exit(code);
  });

program
  .command("init-hooks")
  .description("Install a pre-commit hook that runs Splus (husky/lefthook/pre-commit)")
  .option("--root <dir>", "repository root", ".")
  .option("--fail-on <severity>", "severity that blocks the commit", "high")
  .action((opts: { root: string; failOn: string }) => {
    initHooks(opts.root, opts.failOn);
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
