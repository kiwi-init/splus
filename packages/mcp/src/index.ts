#!/usr/bin/env node
/**
 * @splus/mcp — the Splus MCP server (LOCAL, zero-network).
 *
 * Runs as a stdio MCP server your coding agent (Claude Code, Codex, OpenCode)
 * connects to over stdio. It runs the deterministic Rust engine on your LOCAL
 * checkout, applies this repo's learned suppressions from
 * `.splus-cache/learnings.json`, and returns findings. No account, no token,
 * nothing leaves your machine.
 *
 * The agent is still the reviewer — Splus supplies precise, deterministic
 * findings (each with a provenance anchor + cross-file blast radius); the agent
 * reasons over them, surfaces what matters, and applies fixes. No LLM runs in
 * this process unless you opt in by setting ANTHROPIC_API_KEY, in which case
 * `review` can additionally triage the findings with the LLM layer.
 *
 * Config (env, all optional):
 *   SPLUS_ENGINE      path to the splus-engine binary (else auto-resolved / PATH)
 *   ANTHROPIC_API_KEY enables the opt-in LLM triage path
 *
 * Tools:
 *   review     — review staged / working / base..HEAD / whole-repo changes
 *   dismiss    — teach Splus a finding is noise (generalizes semantically)
 *   mute       — mute an entire rule for this repo
 *   learnings  — list what's been suppressed on this repo
 *   index      — build a SCIP index for the precise blast-radius tier
 *
 * Protocol note: on a stdio transport, stdout IS the MCP channel. Everything
 * human-facing goes to stderr or into a tool result — we never touch stdout.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listChangedFiles, runEngine, type DiffMode, type Finding, type Report } from "@splus/shared";
import {
  applySuppression,
  candidateText,
  FileSuppressionStore,
  type SuppressedFinding,
} from "@splus/suppression";
import type { TriagedReport } from "@splus/triage";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Inlined from packages/mcp/package.json at bundle time (esbuild `define` in
// scripts/build-release.mjs) so the reported version can never drift from the
// package. Falls back to "dev" when run straight from the tsc output.
declare const __SPLUS_VERSION__: string;
const VERSION = typeof __SPLUS_VERSION__ !== "undefined" ? __SPLUS_VERSION__ : "dev";

const server = new McpServer({ name: "splus", version: VERSION });

type ReviewMode = "working" | "staged" | "base" | "all";

// --- shared helpers --------------------------------------------------------

/** Resolve a caller-supplied root, or default to the server's working dir. */
function rootOf(root?: string): string {
  return root ? resolve(root) : process.cwd();
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** The repo-local learned-suppression store (one file per repo). */
function learningsPath(root: string): string {
  return join(root, ".splus-cache", "learnings.json");
}

function toMode(mode: ReviewMode, base: string | null): DiffMode {
  switch (mode) {
    case "staged":
      return { kind: "staged" };
    case "base":
      return { kind: "base", ref: base ?? "" };
    case "all":
      return { kind: "all" };
    default:
      return { kind: "working" };
  }
}

/** Recompute the summary after learned suppression drops some findings. */
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

/**
 * The agent-facing shape of a report. Unlike the CLI's `--agent` output this
 * INCLUDES each finding's `id`, because the agent needs it to call `dismiss`.
 */
function toAgentReport(report: Report, suppressed: SuppressedFinding[]) {
  return {
    summary: {
      filesChanged: report.summary.files_changed,
      addedLines: report.summary.added_lines,
      findings: report.summary.findings_total,
      mustFix: report.summary.must_fix,
      concern: report.summary.concern,
      nit: report.summary.nit,
      suppressedByLearnings: suppressed.length,
      notes: report.summary.notes,
    },
    findings: report.findings.map((f) => ({
      id: f.id,
      file: f.file,
      line: f.region.start_line,
      severity: f.severity,
      tier: f.tier,
      ruleId: f.rule_id,
      category: f.category,
      title: f.title,
      message: f.message,
      anchor: `${f.anchor.kind}: ${f.anchor.detail}`,
      confidence: f.confidence,
      suggestion: f.suggestion ?? null,
      blastRadius: f.blast_radius
        ? {
            symbol: f.blast_radius.symbol,
            directCallers: f.blast_radius.direct_callers,
            transitiveCallers: f.blast_radius.transitive_callers,
            filesAffected: f.blast_radius.files_affected,
            crossesApiBoundary: f.blast_radius.crosses_api_boundary,
            resolutionConfidence: f.blast_radius.resolution_confidence,
            resolutionMethod: f.blast_radius.resolution_method,
          }
        : null,
    })),
    suppressed: suppressed.map((f) => ({
      id: f.id,
      file: f.file,
      line: f.region.start_line,
      ruleId: f.rule_id,
      reason: f.suppressionReason,
      kind: f.suppressionKind ?? null,
    })),
  };
}

/** The agent-facing shape of an LLM-triaged report (opt-in path). */
function toAgentTriaged(t: TriagedReport) {
  return {
    summary: { totalKept: t.findings.length, ...t.llm },
    findings: t.findings.map((f) => ({
      id: f.id,
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

function summaryLine(report: Report, suppressedCount: number): string {
  const s = report.summary;
  const supp = suppressedCount > 0 ? ` · ${suppressedCount} suppressed by learnings` : "";
  return `Splus: ${s.must_fix} must-fix · ${s.concern} concern · ${s.nit} nit on ${s.files_changed} changed file(s)${supp}.`;
}

/**
 * The handoff that makes Splus full-power inside a coding agent: the agent IS the
 * senior reviewer. The deterministic findings are the floor; this directive drives
 * the agent through the discovery pass determinism can't do (logic / security /
 * intent), grounded in the cited code + blast radius. No API key — the frontier
 * model already in the chair does the reasoning.
 */
function discoveryDirective(files: string[]): string {
  const shown = files.slice(0, 40);
  const more = files.length - shown.length;
  const list =
    (shown.map((f) => `  - ${f}`).join("\n") || "  (no changed files)") +
    (more > 0 ? `\n  …and ${more} more` : "");
  return [
    "=== Splus · discovery pass (you are the reviewer) ===",
    "The findings above are the DETERMINISTIC floor — high-precision, each anchored to a pattern, metric, or cross-file graph edge. They are NOT the whole review. You are the senior reviewer in the chair: read the changed code and find what determinism cannot.",
    "",
    "Read the changed files:",
    list,
    "",
    "Hunt for REAL issues, each grounded in a line that exists:",
    "  • correctness — off-by-one, missing await / unhandled error path, wrong condition, null/undefined deref, resource leak, broken invariant",
    "  • security — injection / path-traversal / SSRF reachable from input, authz/IDOR gaps, unsafe deserialization, secret & credential handling, command or eval",
    "  • intent — does the code do what its name, comments, and the change claim? dead, contradictory, or silently fail-open logic",
    "  • failure & concurrency — races, partial writes, retries, fail-open where it must fail-closed",
    "  • blast radius — for any changed export with callers (see findings above), open each call site and confirm it still holds",
    "",
    "Report what you find as must-fix / concern / nit with file:line and a concrete fix. Prefer silence over speculation — never invent a finding; every claim cites a real line. When the user agrees something is noise, call `dismiss` with its id so Splus learns it.",
  ].join("\n");
}

// --- review ----------------------------------------------------------------

server.registerTool(
  "review",
  {
    title: "Review code changes",
    description:
      "Run Splus's deterministic review on NEW/changed lines only (clean-as-you-code), entirely " +
      "on your local machine. Returns findings grouped must-fix / concern / nit — each with " +
      "file:line, rule id, severity, confidence, a deterministic provenance anchor, an optional " +
      "fix, and cross-file blast radius (who calls the changed symbol). Per-repo learned " +
      "suppressions are applied first. No LLM runs unless you pass llm=true (needs " +
      "ANTHROPIC_API_KEY) — otherwise YOU are the reviewer: read these findings, surface the ones " +
      "that matter, and apply fixes. The result ends with a DISCOVERY DIRECTIVE that drives you " +
      "through a senior-reviewer pass over the changed files (logic / security / intent bugs " +
      "determinism can't see) — that's the design: Splus grounds you with precise anchors + blast " +
      "radius, and you, the frontier model in the chair, do the reasoning. Do that pass; don't just " +
      "relay the findings. Set discovery=false to suppress the directive. Pass a finding's `id` to " +
      "the `dismiss` tool when the user agrees something is noise.",
    inputSchema: {
      root: z
        .string()
        .optional()
        .describe("Absolute path to the git repo root. Defaults to the server's working directory."),
      mode: z
        .enum(["working", "staged", "base", "all"])
        .optional()
        .describe(
          "What to review: 'working' = all uncommitted changes vs HEAD (default); " +
            "'staged' = the git index (pre-commit); 'base' = PR-style base..HEAD (needs `base`); " +
            "'all' = the entire committed repo as if newly written.",
        ),
      base: z.string().optional().describe("Base git ref (branch/sha) — used when mode='base'."),
      applyLearnings: z
        .boolean()
        .optional()
        .describe("Apply this repo's learned suppressions (default true)."),
      llm: z
        .boolean()
        .optional()
        .describe("Also triage the findings with the LLM layer (needs ANTHROPIC_API_KEY). Default false."),
      thorough: z
        .boolean()
        .optional()
        .describe("With llm=true, also run the headless discovery pass (frontier API model) for logic/security bugs."),
      discovery: z
        .boolean()
        .optional()
        .describe(
          "Append the directive that drives YOU (the agent) through the senior-reviewer discovery pass over the changed files. Default true — this is what makes Splus full-power in an interactive agent (no API key; you are the model).",
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ root, mode, base, applyLearnings, llm, thorough, discovery }) => {
    const repo = rootOf(root);
    const m = (mode ?? "working") as ReviewMode;
    if (m === "base" && !base) return fail("mode='base' requires a `base` ref.");
    const dmode = toMode(m, base ?? null);

    let report: Report;
    try {
      report = await runEngine({ root: repo, mode: dmode });
    } catch (e) {
      return fail(
        `Could not run the Splus engine: ${e instanceof Error ? e.message : String(e)}. ` +
          `Ensure splus-engine is installed (or SPLUS_ENGINE points at it) and ${repo} is a git repo.`,
      );
    }

    // Learned suppression (on by default): drop findings already dismissed on
    // this repo (exact, rule-mute, or semantically similar). Best-effort.
    let suppressed: SuppressedFinding[] = [];
    if (applyLearnings !== false) {
      try {
        const store = new FileSuppressionStore(learningsPath(repo));
        const r = await applySuppression(report, store);
        report = withFindings(report, r.kept, r.suppressed.length);
        suppressed = r.suppressed;
      } catch {
        /* never block a review on the suppression store */
      }
    }

    // Optional LLM triage (opt-in). Dynamically imported so the Anthropic SDK is
    // only loaded when actually used. Falls back to deterministic on any error.
    if (llm) {
      try {
        const { triage } = await import("@splus/triage");
        const triaged = await triage(report, {
          root: repo,
          thorough: thorough === true,
          changedFiles: listChangedFiles(repo, dmode),
        });
        return ok(
          `${summaryLine(report, suppressed.length)}\n\n${JSON.stringify(toAgentTriaged(triaged), null, 2)}`,
        );
      } catch (e) {
        process.stderr.write(
          `splus-mcp: LLM triage unavailable (${e instanceof Error ? e.message : String(e)}); ` +
            `returning deterministic findings.\n`,
        );
      }
    }

    const payload = toAgentReport(report, suppressed);
    const body = `${summaryLine(report, suppressed.length)}\n\n${JSON.stringify(payload, null, 2)}`;
    // The handoff: ground the agent, then drive it through the discovery pass.
    if (discovery === false) return ok(body);
    return ok(`${body}\n\n${discoveryDirective(listChangedFiles(repo, dmode))}`);
  },
);

// --- dismiss ---------------------------------------------------------------

server.registerTool(
  "dismiss",
  {
    title: "Dismiss a finding (teach the suppressor)",
    description:
      "Teach Splus to stop flagging a specific finding on THIS repo, by its `id` from a prior " +
      "review. Use when the user confirms a finding is a false positive or noise. The dismissal " +
      "generalizes: semantically-similar findings (even in other files) are auto-suppressed going " +
      "forward. Looks the finding up in the current diff to capture its text for matching. Written " +
      "to .splus-cache/learnings.json in the repo.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
      id: z.string().describe("The finding id (fingerprint) to dismiss, as returned by `review`."),
      mode: z
        .enum(["working", "staged", "base", "all"])
        .optional()
        .describe("Where to look up the finding's text for semantic generalization (default 'working')."),
      base: z.string().optional().describe("Base git ref — used when mode='base'."),
      ruleId: z
        .string()
        .optional()
        .describe("The finding's rule id (from `review`) — improves generalization if it's not in the current diff."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ root, id, mode, base, ruleId }) => {
    const repo = rootOf(root);
    const m = (mode ?? "working") as ReviewMode;
    const store = new FileSuppressionStore(learningsPath(repo));

    // Re-run the engine to recover the finding's text + rule so the semantic
    // tier can generalize. Best-effort: an exact-only dismissal still works if
    // the finding isn't in the current diff.
    let found: Finding | undefined;
    try {
      if (!(m === "base" && !base)) {
        const report = await runEngine({ root: repo, mode: toMode(m, base ?? null) });
        found = report.findings.find((f) => f.id === id);
      }
    } catch {
      /* fall through to an exact-only dismissal */
    }

    await store.record({
      fingerprint: id,
      rule_id: found?.rule_id ?? ruleId ?? "unknown",
      text: found ? candidateText(found) : "",
      scope: "fingerprint",
    });

    return ok(
      found
        ? `Dismissed ${id} (${found.rule_id}). Splus won't flag it — or close variants — on this repo again.`
        : `Dismissed ${id} (exact match only — it wasn't in the current diff, so no semantic generalization).`,
    );
  },
);

// --- mute ------------------------------------------------------------------

server.registerTool(
  "mute",
  {
    title: "Mute a rule for this repo",
    description:
      "Mute an entire rule on THIS repo (e.g. 'hygiene.console-log'). Use when the user never " +
      "wants this class flagged here. Stronger than dismiss — silences every finding with this " +
      "rule id, regardless of file or wording.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
      ruleId: z.string().describe("The rule id to mute (from a finding's `ruleId`)."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ root, ruleId }) => {
    const repo = rootOf(root);
    const store = new FileSuppressionStore(learningsPath(repo));
    await store.record({ fingerprint: "", rule_id: ruleId, text: ruleId, scope: "rule", signal: "muted" });
    return ok(`Muted rule '${ruleId}' for this repo. Splus will stop flagging it.`);
  },
);

// --- learnings -------------------------------------------------------------

server.registerTool(
  "learnings",
  {
    title: "List learned suppressions",
    description:
      "List what Splus has learned to suppress on this repo — dismissed finding ids and muted " +
      "rules, with the signal and timestamp for each. Read from .splus-cache/learnings.json.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ root }) => {
    const repo = rootOf(root);
    const store = new FileSuppressionStore(learningsPath(repo));
    const entries = await store.list();
    if (!entries.length) {
      return ok("No learnings yet. Use the `dismiss` or `mute` tools to teach this repo.");
    }
    return ok(JSON.stringify(entries, null, 2));
  },
);

// --- index (precise blast-radius tier) -------------------------------------

server.registerTool(
  "index",
  {
    title: "Build a SCIP index (precise blast radius)",
    description:
      "Generate a compiler-grade SCIP index so blast-radius resolves precisely (~97% vs the ~60% " +
      "name heuristic). Runs the appropriate Sourcegraph indexer locally (scip-typescript / " +
      "scip-python) and writes .splus-cache/index.scip, which `review` auto-detects. Needs the " +
      "project's deps installed; meant for occasional/CI use, not the hot path.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ root }) => {
    const repo = rootOf(root);
    mkdirSync(join(repo, ".splus-cache"), { recursive: true });
    const out = join(".splus-cache", "index.scip");
    let indexer: string;
    if (existsSync(join(repo, "tsconfig.json"))) indexer = "@sourcegraph/scip-typescript";
    else if (existsSync(join(repo, "pyproject.toml")) || existsSync(join(repo, "setup.py")))
      indexer = "@sourcegraph/scip-python";
    else return fail("No tsconfig.json or pyproject.toml found — nothing to index here.");

    const r = spawnSync("npx", ["--yes", indexer, "index", "--output", out], {
      cwd: repo,
      encoding: "utf8",
    });
    if (r.status === 0) {
      return ok(
        `Indexed with ${indexer} → ${join(repo, out)}. \`review\` will auto-detect it for precise ` +
          `(compiler-grade) blast radius.`,
      );
    }
    return fail(
      `Indexer failed (exit ${r.status ?? "?"}). Ensure the project's deps are installed and it ` +
        `typechecks.\n${(r.stderr || r.stdout || "").slice(0, 600)}`,
    );
  },
);

// --- boot ------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const llm = process.env.ANTHROPIC_API_KEY?.trim()
    ? "LLM triage available (ANTHROPIC_API_KEY set)"
    : "deterministic only (set ANTHROPIC_API_KEY for optional LLM triage)";
  process.stderr.write(
    `splus-mcp ready (stdio) — local engine, no network · ${llm}; tools: review, dismiss, mute, learnings, index\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`splus-mcp: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
