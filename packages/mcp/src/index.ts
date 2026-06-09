#!/usr/bin/env node
/**
 * @splus/mcp — the Splus MCP server (LOCAL-first, no account/token).
 *
 * Runs as a stdio MCP server your coding agent (Claude Code, Codex, OpenCode)
 * connects to over stdio. It runs the deterministic Rust engine on your LOCAL
 * checkout, applies this repo's learned suppressions from
 * `.splus-cache/learnings.json`, and returns findings. No account, no token,
 * and your code never leaves your machine. The one exception to "no network" is
 * the OPT-IN precise tier (`review precise:true` / the `index` tool), which
 * fetches a SCIP indexer from npm via `npx --yes` on first use — annotated
 * `openWorldHint: true`. Reviews without it are fully offline.
 *
 * ONE flow, and the agent in the chair is the driver: Splus supplies precise,
 * deterministic findings (each with a provenance anchor + cross-file blast
 * radius), and `review` returns a directive that drives the agent through the
 * full review protocol (triage → discover → verify) over the changed code. No
 * API key, ever — the frontier model already in the session does the reasoning.
 *
 * Config (env, all optional):
 *   SPLUS_ENGINE  path to the splus-engine binary (else auto-resolved / PATH)
 *
 * Tools:
 *   review      — review staged / working / base..HEAD / whole-repo changes (reads SPLUS.md)
 *   inspect     — the engine on tap: definition / callers / blast_radius / complexity / exports / imports
 *   floor       — re-ground on the deterministic finding floor for a scope (no directive)
 *   preferences — show the merged SPLUS.md contract (repo + ~/.splus)
 *   report      — render the review as a standalone offline HTML report (final step)
 *   dismiss     — teach Splus a finding is noise (generalizes semantically)
 *   accept      — teach Splus a finding was real (reinforces + stores recallable memory)
 *   note        — remember a discovered repo convention (→ recall)
 *   recall      — surface confirmed findings / conventions relevant to a hunk
 *   mute        — mute an entire rule for this repo
 *   learnings   — list what's been learned on this repo
 *   index       — build a SCIP index for the precise blast-radius tier
 *
 * Protocol note: on a stdio transport, stdout IS the MCP channel. Everything
 * human-facing goes to stderr or into a tool result — we never touch stdout.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  applyPolicy,
  changedExportedSymbols,
  diffText,
  inspect as engineInspect,
  listChangedFiles,
  loadSplusConfig,
  runEngine,
  type DiffMode,
  type Finding,
  type InspectKind,
  type Report,
  type SplusConfig,
} from "@splus/shared";
import {
  applySuppression,
  candidateText,
  FileMemoryStore,
  FileSuppressionStore,
  type SuppressedFinding,
} from "@splus/suppression";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  auditBlock,
  extendFloor,
  recordInspect,
  recordResolution,
  startLedger,
} from "./audit.js";
import { REPORT_TEMPLATE } from "./reportTemplate.js";

// Inlined from packages/mcp/package.json at bundle time (esbuild `define` in
// scripts/build-release.mjs) so the reported version can never drift from the
// package. Falls back to "dev" when run straight from the tsc output.
declare const __SPLUS_VERSION__: string;
const VERSION = typeof __SPLUS_VERSION__ !== "undefined" ? __SPLUS_VERSION__ : "dev";

/**
 * Server-level instructions, surfaced to the host agent at connection time —
 * BEFORE it plans its first move. This is where the "one flow, you are the
 * driver, never ask about an API key" contract has to live: a directive inside
 * a tool *result* arrives too late to stop the agent from asking the user first.
 */
const SERVER_INSTRUCTIONS = `Splus turns the coding agent already in this session into a disciplined, precision-first code reviewer. You are the reviewer in the chair — the engine is yours to interrogate, not a list to relay. There is no API key and no clock: curiosity and verification are the job, and a wrong comment costs more than a slow review.

When the user asks you to review code:
1. \`review\` (mode: working/staged/base/all; precise:true for compiler-grade blast radius). It reads the repo's \`SPLUS.md\` contract (its preferences + binding nits — honor them; they come first), returns the deterministic FLOOR of findings, and hands you a directive. Do NOT ask about a "deterministic-only" mode or an ANTHROPIC_API_KEY — neither exists here.
2. INVESTIGATE, don't triage a list. The floor is grounding; the review is what you find. Pull deterministic signal on demand with \`inspect\` (kind: definition | callers | blast_radius | complexity | exports | imports) — when an export looks risky, open its callers and confirm the blast radius; recurse when something smells off. Use \`floor\` to re-ground a file subset. Read the changed code for what determinism can't see: logic, security, intent, concurrency.
3. VERIFY every finding by trying to refute it against the cited line. Drop any you can't defend. Then REPORT survivors as must-fix / concern / nit with file:line and a concrete fix.
4. TEACH the repo: \`dismiss <id>\` for noise, \`accept <id>\` for real, \`note\` to record a convention. \`preferences\` shows the active \`SPLUS.md\`; \`recall\` surfaces what was learned here before.

Other tools: \`report\` audits your protocol coverage deterministically (pass \`keptIds\`; it sees which exports you actually inspected and which floor findings got an explicit fate) and renders the offline HTML deliverable, \`mute\` silences a rule, \`learnings\` lists what's been taught, \`index\` builds a SCIP index for precise blast radius.`;

const server = new McpServer({ name: "splus", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

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

/** The repo-local compounding-memory store (one file per repo). */
function memoryPath(root: string): string {
  return join(root, ".splus-cache", "memory.json");
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

/**
 * The `SPLUS.md` contract block, prepended to the review so the agent reads the
 * repo's standing preferences BEFORE planning — and an honest record of any
 * finding the binding `mute:`/`skip:` rules dropped (never silent).
 */
function prefsBlock(cfg: SplusConfig, dropped: { ruleId: string; file: string; reason: string }[]): string {
  const lines: string[] = ["=== SPLUS.md · the repo's review contract (read first) ==="];
  if (cfg.source === "none") {
    lines.push(
      "No SPLUS.md found. Reviewing with engine defaults. If the user has standing preferences or",
      "repo nits, offer to scaffold one (the `prefs` skill) — it makes the next review serve their taste.",
    );
  } else {
    lines.push(
      `These are standing preferences (${cfg.source}); they override engine defaults and your own taste:`,
      "",
      cfg.raw.trim(),
    );
  }
  if (dropped.length) {
    lines.push(
      "",
      `Dropped by SPLUS.md policy (${dropped.length}): ` +
        dropped.map((d) => `${d.ruleId}@${d.file} (${d.reason})`).join("; "),
    );
  }
  lines.push("=== end SPLUS.md ===");
  return lines.join("\n");
}

function summaryLine(report: Report, suppressedCount: number): string {
  const s = report.summary;
  const supp = suppressedCount > 0 ? ` · ${suppressedCount} suppressed by learnings` : "";
  return `Splus: ${s.must_fix} must-fix · ${s.concern} concern · ${s.nit} nit on ${s.files_changed} changed file(s)${supp}.`;
}

/**
 * The handoff — and the whole product. The agent in the chair IS the reviewer.
 * The deterministic findings are the floor; this directive drives the agent
 * through the same protocol the engine can only ground, as explicit numbered
 * stages (triage → discover → verify → report → teach) so the review is run, not
 * relayed. No API key — the frontier model already in the session does the work.
 */
function discoveryDirective(files: string[], changedSymbols: string[] = []): string {
  const shown = files.slice(0, 40);
  const more = files.length - shown.length;
  const list =
    (shown.map((f) => `  - ${f}`).join("\n") || "  (no changed files)") +
    (more > 0 ? `\n  …and ${more} more` : "");
  const symbolBlock = changedSymbols.length
    ? [
        "",
        "Changed exported symbols (deterministic — the contracts this change touches):",
        ...changedSymbols.map((s) => `  - ${s}`),
      ]
    : [];
  return [
    "=== Splus · you are the reviewer (one flow — no API key, no clock) ===",
    "The findings above are the DETERMINISTIC FLOOR — high-precision, each anchored to a pattern, metric, or cross-file graph edge. They are NOT the review. You are the senior reviewer in the chair, seeing this code for the first time: run the full protocol over the changed code yourself. Take the time it takes — curiosity is the job.",
    "",
    "Changed files:",
    list,
    ...symbolBlock,
    "",
    "1. TRIAGE — for each finding above, decide keep vs suppress. Optimize for signal: suppress test fixtures, idiomatic patterns for the file's role, and pure style; keep what a senior reviewer would genuinely want fixed before merge. A noisy comment costs more than a missed nit.",
    "2. TRACE CONTRACTS — for EACH changed exported symbol above (or any changed function if the list is empty), run this discipline; it catches the single most-missed real-bug class (return-shape drift):",
    "   a. enumerate what it returns/throws on EVERY path after this change — success, error, missing/invalid input, each early return — with the exact shape (object keys, wrapper types like {success,data,error}, Response vs parsed body, promise vs value);",
    "   b. `inspect callers` / `inspect blast_radius`, then OPEN each call site and state what shape that caller assumes (property accesses, destructuring, truthiness checks);",
    "   c. report every mismatch. One changed function often breaks several callers — finding one mismatch means checking the remaining call sites, not stopping.",
    "3. DISCOVER — read the changed code and find what determinism cannot. Don't guess — INTERROGATE THE ENGINE with `inspect` (kind: definition | callers | blast_radius | complexity | exports | imports); when a hunk smells off, open its callers and confirm the blast radius before you move on. Each finding must be grounded in a line that exists:",
    "   • correctness — off-by-one, missing await / unhandled error path, wrong condition, case-sensitive comparison where input case varies, null/undefined deref, resource leak, broken invariant",
    "   • security — injection / path-traversal / SSRF reachable from input, authz/IDOR gaps, unsafe deserialization, secret & credential handling, command or eval",
    "   • intent — does the code do what its name, comments, and the change claim? dead, contradictory, or silently fail-open logic",
    "   • failure & concurrency — races, partial writes, retries, fail-open where it must fail-closed, concurrent mutation of shared state on request paths",
    "   Spend your comments on the CHANGE's own logic. Do NOT pad the review with generic best-practice concerns (timing-safe comparison, rate limiting, header normalization, hardening on trusted paths) unless the diff clearly introduces the flaw — that padding is the #1 source of review noise.",
    "4. VERIFY — before posting anything, re-read each candidate's cited line and try to REFUTE it. Drop any you can't defend (already handled nearby, speculative, the line doesn't actually demonstrate it). A wrong comment costs more than a missed nit.",
    "5. REPORT — the survivors as must-fix / concern / nit with file:line and a concrete fix. Never invent a finding; every claim cites a real line.",
    "6. TEACH — `dismiss <id>` when the user agrees something is noise, `accept <id>` when they act on a real one — Splus learns this repo both ways.",
    "7. RENDER — the deliverable that ends the review: call the `report` tool with `keptIds` (the floor ids your verified review keeps). Its response OPENS with a deterministic protocol audit — computed from this session's actual tool calls — certifying every changed export above was `inspect`ed and every floor finding got an explicit fate (kept / dismissed / accepted). Close any gap it lists, then fill the returned HTML template with the verdict + your verified survivors + the file-level impact graph, and write `splus-report.html`. One self-contained, offline file — the artifact a dev keeps next to the diff.",
  ].join("\n");
}

/**
 * The fill spec handed back with the report template. The agent has the VERIFIED
 * findings (which differ from the raw deterministic floor), so the agent — not the
 * server — fills the template; the server only ships the locked design.
 */
function reportInstructions(): string {
  return [
    "=== Splus · render the review report (final step) ===",
    "Write the HTML template below to `splus-report.html`, then fill it from your VERIFIED review.",
    "It must stay ONE self-contained file — all CSS/JS inline, no CDN — so it opens offline. Do NOT restyle: black background, monospace, color only for the accents the stylesheet already defines.",
    "",
    "Fill ONLY the regions marked  ⟦SLOT:name⟧ … ⟦/SLOT⟧  (each ships an example to replace):",
    "  • masthead — repo, what was reviewed (`mode`), files & +added, engine version, date",
    "  • verdict  — chip `good` \"SAFE TO MERGE\" iff must-fix == 0; else chip `bad` \"CHANGES REQUESTED\" with the must-fix count (set the matching border-left-color + box-shadow). Use chip `warn` for a triaged verdict. Merge confidence = 1–5 segments.",
    "  • tiles    — files, added, must-fix, concern, nit, suppressed (a tile gets its accent class has-mf/has-cn/has-nt only when its count > 0)",
    "  • prose    — 1–3 short paragraphs: what was reviewed, how blast radius resolved (heuristic vs SCIP), the headline takeaway (optional)",
    "  • graph (DATA) — THE CENTERPIECE: one node per changed module laid out left→right by `col` (inputs → core → consumers), edges pointing the way impact propagates, `badge` = finding count, `tip` = hover card. Color hotspots with `tone`.",
    "  • files (FILES) — the drill-down map, keyed by the same id you gave hero nodes AND each finding card's `data-file`; optional symbol-level `graph` whose nodes can carry `finding:\"f-…\"` to jump to a card",
    "  • findings — one `<article class=\"find f-…\">` per verified finding, in tier order (must-fix → concern → nit). Render title, file:line, message, category/rule-id/anchor, the confidence bar, and any `suggestion` as a diff block (`+`/`-` lines). `data-file` MUST match a FILES key. Drop sub-blocks a finding lacks.",
    "  • affects (AFFECTS) — optional per-finding blast-radius graph; add an entry whose `id` matches the card's `<svg>` id",
    "  • hotspots — the modules carrying the most signal (or the cleanest)",
    "  • footer — collectors run, blast-radius precision (heuristic vs SCIP), the `dismiss`/`accept` teach hint",
    "",
    "Keep the section order: Verdict → Summary → Impact graph → Findings → Hotspots → Footer. When done, tell the user the path and that it opens offline.",
    "",
    "--- TEMPLATE (write verbatim, then fill the slots) ---",
    REPORT_TEMPLATE,
  ].join("\n");
}

// --- review ----------------------------------------------------------------

server.registerTool(
  "review",
  {
    title: "Review code changes",
    description:
      "Review code changes — YOU, the coding agent in this session, are the reviewer; no API key, " +
      "ever. One flow: this runs Splus's deterministic engine on the NEW/changed lines only " +
      "(clean-as-you-code, entirely local) to give you a grounded FLOOR of findings — each grouped " +
      "must-fix / concern / nit with file:line, rule id, severity, confidence, a deterministic " +
      "provenance anchor, an optional fix, and cross-file blast radius — applies this repo's learned " +
      "suppressions, and returns a DISCOVERY DIRECTIVE. Execute that directive: it drives you through " +
      "the full review protocol over the changed files — TRIAGE each finding (keep/suppress for " +
      "signal), DISCOVER the logic / security / intent bugs determinism can't see, VERIFY every " +
      "finding by trying to refute it against the cited line, then REPORT the survivors with concrete " +
      "fixes. Don't just relay the findings — running the protocol IS the review. Then teach the repo: " +
      "`dismiss <id>` when something is noise, `accept <id>` when a finding was real. Scope with `mode` " +
      "(working / staged / base / all); set `precise:true` to build a SCIP index first for " +
      "compiler-grade blast radius.",
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
      precise: z
        .boolean()
        .optional()
        .describe(
          "Build a SCIP index first (scip-typescript / scip-python) so cross-file blast radius is compiler-grade (~97%) instead of the name heuristic (~60%). On first run this fetches the indexer via `npx --yes` (a network call); skipped if `.splus-cache/index.scip` already exists (delete it or run the `index` tool to refresh). Slower (needs the project's deps). Default false.",
        ),
    },
    // `openWorldHint: true` because `precise:true` shells out to `npx --yes
    // <indexer>`, which can fetch from the npm registry on first run — the review
    // itself is local, but this path is not closed-world. (No user code leaves the
    // machine; only the public indexer package is fetched.)
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ root, mode, base, applyLearnings, precise }) => {
    const repo = rootOf(root);
    const m = (mode ?? "working") as ReviewMode;
    if (m === "base" && !base) return fail("mode='base' requires a `base` ref.");
    const dmode = toMode(m, base ?? null);

    // Precise blast-radius (opt-in): generate the SCIP index so the engine resolves
    // cross-file impact compiler-grade. The engine auto-detects the written index.
    const preciseNotes: string[] = [];
    if (precise) {
      if (hasScipIndex(repo)) {
        // An index already exists — reuse it rather than rebuild every review.
        // Freshness isn't re-verified here, so say so: a stale index (built at an
        // earlier commit) resolves blast radius against outdated positions.
        preciseNotes.push(
          "Precise blast radius: reusing the existing .splus-cache/index.scip — run the `index` tool (or delete the file) to rebuild if it's stale.",
        );
      } else {
        const r = buildScipIndex(repo);
        preciseNotes.push(
          r.status === "indexed"
            ? "Precise blast radius: SCIP index built — cross-file impact is compiler-grade."
            : `Precise blast radius requested but unavailable (${r.status}); using the name+import heuristic tier.`,
        );
      }
    }

    let report: Report;
    try {
      report = await runEngine({ root: repo, mode: dmode });
    } catch (e) {
      return fail(
        `Could not run the Splus engine: ${e instanceof Error ? e.message : String(e)}. ` +
          `Ensure splus-engine is installed (or SPLUS_ENGINE points at it) and ${repo} is a git repo.`,
      );
    }

    // The repo contract (`SPLUS.md`): inject its prose, enforce its binding
    // `mute:`/`skip:` rules. This runs BEFORE learned suppression so a stated
    // preference always wins over the engine's defaults.
    const cfg = loadSplusConfig(repo);
    const policy = applyPolicy(report.findings, cfg);
    report = withFindings(report, policy.kept, report.summary.suppressed);

    // Learned suppression (on by default): drop findings already dismissed on
    // this repo (exact, rule-mute, or semantically similar). Best-effort.
    let suppressed: SuppressedFinding[] = [];
    let reinforcedIds: string[] = [];
    let revalidations: Array<{ id: string; reason: string }> = [];
    if (applyLearnings !== false) {
      try {
        const store = new FileSuppressionStore(learningsPath(repo));
        const r = await applySuppression(report, store);
        report = withFindings(report, r.kept, r.suppressed.length);
        suppressed = r.suppressed;
        reinforcedIds = r.reinforced.map((x) => x.id);
        revalidations = r.revalidations;
      } catch {
        /* never block a review on the suppression store */
      }
    }
    const reinforcedNote =
      reinforcedIds.length > 0
        ? `\n\nReinforced (resemble findings this repo previously confirmed real — surface these first): ${reinforcedIds.join(", ")}`
        : "";
    // Suppression decay: these findings were dismissed long enough ago that the
    // learning aged out — they resurface ONCE for re-validation, never silently.
    const revalidationNote =
      revalidations.length > 0
        ? `\n\nRe-validation (aged suppressions resurfaced — confirm each is still noise and re-dismiss, or treat it as real): ${revalidations
            .map((x) => `${x.id} — ${x.reason}`)
            .join("; ")}`
        : "";
    const preciseNote = preciseNotes.length ? `\n\n${preciseNotes.join("\n")}` : "";

    const payload = toAgentReport(report, suppressed);
    const body = `${summaryLine(report, suppressed.length)}\n\n${JSON.stringify(payload, null, 2)}${reinforcedNote}${revalidationNote}${preciseNote}`;
    // Deterministic AIM for the contract-trace stage: which exported symbols the
    // diff actually touches (engine exports ∩ hunks). Best-effort and capped —
    // an engine hiccup or a huge change surface must never block the review.
    const changedFiles = listChangedFiles(repo, dmode);
    let changedSymbols: string[] = [];
    try {
      changedSymbols = await changedExportedSymbols(repo, changedFiles.slice(0, 20), diffText(repo, dmode));
    } catch {
      /* aim is enrichment, never load-bearing */
    }
    // Open the protocol-audit ledger for this review: the floor ids the agent
    // was handed + the changed-export contracts it owes traces for. `inspect`,
    // `dismiss`, and `accept` record into it; `report` audits it.
    startLedger(
      repo,
      report.findings.map((f) => f.id),
      changedSymbols,
    );
    // The handoff, and the whole product: read the repo contract first, ground the
    // agent with the deterministic floor, then drive it through the protocol. The
    // directive is ALWAYS appended — there is no other path, no key, no headless
    // mode to choose between.
    return ok(
      `${prefsBlock(cfg, policy.dropped)}\n\n${body}\n\n${discoveryDirective(changedFiles, changedSymbols)}`,
    );
  },
);

// --- inspect (the engine on tap) -------------------------------------------

server.registerTool(
  "inspect",
  {
    title: "Inspect code intelligence on demand",
    description:
      "The engine ON TAP — ask ONE deterministic question instead of triaging a list. Use it to " +
      "investigate while you review: when a changed export looks risky, pull its callers and blast " +
      "radius and open the call sites; recurse when a hunk smells off. Local, instant, grounded. " +
      "Kinds: 'definition' (where a symbol is defined), 'callers' (files importing it), " +
      "'blast_radius' (full cross-file impact, SCIP-precise when an index exists else the name " +
      "heuristic), 'complexity' (cognitive complexity per function in a file), 'exports' / 'imports' " +
      "(a file's surface). `target` is a SYMBOL for definition/callers/blast_radius and a FILE PATH " +
      "for complexity/exports/imports. Resolution is JS/TS-aware; non-JS/TS symbols return an honest " +
      "empty answer.",
    inputSchema: {
      kind: z
        .enum(["definition", "callers", "blast_radius", "complexity", "exports", "imports"])
        .describe("Which question to ask."),
      target: z
        .string()
        .describe("Symbol name (definition/callers/blast_radius) or file path (complexity/exports/imports)."),
      file: z
        .string()
        .optional()
        .describe("Pin the defining file for a symbol query (disambiguates same-named symbols)."),
      root: z.string().optional().describe("Repo root (default: server CWD)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ kind, target, file, root }) => {
    const repo = rootOf(root);
    try {
      const value = await engineInspect({ root: repo, kind: kind as InspectKind, target, file });
      // A successful interrogation counts toward the protocol audit.
      recordInspect(repo, kind, target);
      return ok(JSON.stringify(value, null, 2));
    } catch (e) {
      return fail(`inspect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

// --- floor (re-ground on the deterministic findings) -----------------------

server.registerTool(
  "floor",
  {
    title: "Re-ground on the deterministic finding floor",
    description:
      "Return the engine's deterministic finding FLOOR for a scope as JSON — the same grounded set " +
      "`review` starts from, but without the directive. Use it to re-check a file subset or a " +
      "different scope mid-investigation. The repo's `SPLUS.md` binding rules are applied; learned " +
      "suppression is not (this is the raw floor).",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
      mode: z
        .enum(["working", "staged", "base", "all"])
        .optional()
        .describe("Scope (default 'working')."),
      base: z.string().optional().describe("Base git ref — used when mode='base'."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ root, mode, base }) => {
    const repo = rootOf(root);
    const m = (mode ?? "working") as ReviewMode;
    if (m === "base" && !base) return fail("mode='base' requires a `base` ref.");
    try {
      const report = await runEngine({ root: repo, mode: toMode(m, base ?? null) });
      const cfg = loadSplusConfig(repo);
      const policy = applyPolicy(report.findings, cfg);
      const filtered = withFindings(report, policy.kept, report.summary.suppressed);
      // Mid-review re-grounding: whatever the agent saw here joins the floor it
      // must account for in the protocol audit.
      extendFloor(repo, filtered.findings.map((f) => f.id));
      return ok(JSON.stringify(toAgentReport(filtered, []), null, 2));
    } catch (e) {
      return fail(`Could not run the Splus engine: ${e instanceof Error ? e.message : String(e)}.`);
    }
  },
);

// --- preferences (the SPLUS.md contract) -----------------------------------

server.registerTool(
  "preferences",
  {
    title: "Show the active SPLUS.md contract",
    description:
      "Return the merged `SPLUS.md` review contract for this repo (repo `./SPLUS.md` layered over " +
      "`~/.splus/SPLUS.md`), including its binding `mute:`/`skip:` rules. This is the repo's standing " +
      "preferences + nits — `review` already injects it, but call this to read it directly.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ root }) => {
    const cfg = loadSplusConfig(rootOf(root));
    if (cfg.source === "none") {
      return ok(
        "No SPLUS.md found (repo root or ~/.splus/SPLUS.md). Reviewing with engine defaults — the " +
          "`prefs` skill scaffolds one so the next review serves the repo's taste.",
      );
    }
    return ok(
      `SPLUS.md (${cfg.source})\nmuted rules: ${cfg.mutedRules.join(", ") || "—"}\n` +
        `skip paths: ${cfg.skipPaths.join(", ") || "—"}\n\n${cfg.raw.trim()}`,
    );
  },
);

// --- report (final step of the review flow) --------------------------------

server.registerTool(
  "report",
  {
    title: "Render the review as a standalone HTML report",
    description:
      "The FINAL STEP of the review flow. Opens with a DETERMINISTIC PROTOCOL AUDIT — computed from " +
      "this session's actual tool calls — that certifies every changed export was `inspect`ed and " +
      "every floor finding got an explicit fate (kept / dismissed / accepted); pass `keptIds` (the " +
      "floor ids your verified review keeps) so floor coverage can be certified, and close any gap " +
      "the audit lists before writing the file. Then returns a self-contained HTML template (all " +
      "CSS/JS + the impact graph inline — no CDN, opens offline) plus fill instructions. Fill the " +
      "marked ⟦SLOT⟧ regions with the verdict, your verified findings, and the file-level impact " +
      "graph, and write `splus-report.html`. The graph (files = nodes, impact = edges, hover traces " +
      "blast radius, click drills into a module) is the centerpiece. The template is fixed/locked — " +
      "you supply data only, not styling. The result is the shareable artifact a dev keeps next to " +
      "the diff.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
      keptIds: z
        .array(z.string())
        .optional()
        .describe(
          "The floor finding ids your VERIFIED report keeps. The audit certifies every floor " +
            "finding was explicitly kept, dismissed, or accepted — ids you neither keep nor teach " +
            "are flagged as unaccounted.",
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ root, keptIds }) => ok(`${auditBlock(rootOf(root), keptIds)}\n\n${reportInstructions()}`),
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
    recordResolution(repo, id, "dismissed");

    return ok(
      found
        ? `Dismissed ${id} (${found.rule_id}). Splus won't flag it — or close variants — on this repo again.`
        : `Dismissed ${id} (exact match only — it wasn't in the current diff, so no semantic generalization).`,
    );
  },
);

// --- accept ----------------------------------------------------------------

server.registerTool(
  "accept",
  {
    title: "Accept a finding (teach the reviewer what matters here)",
    description:
      "Teach Splus that a finding was REAL and worth surfacing on THIS repo, by its `id` from a " +
      "prior review. The inverse of `dismiss`: it never suppresses anything — it builds positive " +
      "memory so that future findings resembling this confirmed-real one are reinforced (ranked " +
      "higher), so the review learns what this repo's reviewers actually care about. Call it when " +
      "the user acts on / agrees with a finding (including agent-discovered ones). Written to " +
      ".splus-cache/learnings.json in the repo.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
      id: z.string().describe("The finding id (fingerprint) to accept, as returned by `review`."),
      ruleId: z.string().optional().describe("The finding's rule id (improves reinforcement matching)."),
      text: z
        .string()
        .optional()
        .describe("The finding's text (title + rationale). For agent-discovered findings not in the engine's output, pass it so reinforcement can generalize."),
      mode: z.enum(["working", "staged", "base", "all"]).optional().describe("Where to look up the finding's text (default 'working')."),
      base: z.string().optional().describe("Base git ref — used when mode='base'."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ root, id, ruleId, text, mode, base }) => {
    const repo = rootOf(root);
    const m = (mode ?? "working") as ReviewMode;
    const store = new FileSuppressionStore(learningsPath(repo));

    // Recover the finding's text from the engine if not supplied (best-effort).
    let found: Finding | undefined;
    if (!text) {
      try {
        if (!(m === "base" && !base)) {
          const report = await runEngine({ root: repo, mode: toMode(m, base ?? null) });
          found = report.findings.find((f) => f.id === id);
        }
      } catch {
        /* fall through */
      }
    }

    const memText = text ?? (found ? candidateText(found) : "");
    await store.record({
      fingerprint: id,
      rule_id: found?.rule_id ?? ruleId ?? "unknown",
      text: memText,
      scope: "fingerprint",
      signal: "accepted",
    });
    // Also store it as compounding memory so future reviews can `recall` it.
    if (memText) {
      await new FileMemoryStore(memoryPath(repo)).remember({ kind: "accepted", text: memText });
    }
    recordResolution(repo, id, "accepted");

    return ok(
      `Accepted ${id}. Splus will reinforce findings like this one — and \`recall\` it on future reviews.`,
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

// --- recall (compounding memory) -------------------------------------------

server.registerTool(
  "recall",
  {
    title: "Recall what was learned here before",
    description:
      "Surface past confirmed-real findings (`accept`) and discovered conventions (`note`) most " +
      "relevant to a hunk, symbol, or question — so a reviewer's diligence compounds across sessions " +
      "instead of starting cold. Semantic (embedding) match over .splus-cache/memory.json. Call it " +
      "while investigating a risky area: 'have we been burned here before?'",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
      query: z.string().describe("A hunk, symbol, error, or question to recall memories for."),
      limit: z.number().optional().describe("Max memories to return (default 5)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ root, query, limit }) => {
    const store = new FileMemoryStore(memoryPath(rootOf(root)));
    const hits = await store.recall(query, { limit });
    if (!hits.length) {
      return ok("No relevant memories yet. Use `accept` on real findings and `note` for conventions to build them.");
    }
    return ok(JSON.stringify(hits, null, 2));
  },
);

// --- note (teach the repo a convention) ------------------------------------

server.registerTool(
  "note",
  {
    title: "Record a convention the review discovered",
    description:
      "Remember a repo convention or context you discovered while reviewing (e.g. 'this module uses " +
      "Result<T,E>, never throws' or 'auth/ requires every handler to call requireSession first'), so " +
      "future reviews `recall` it. Complements `accept` (which remembers confirmed findings). Written " +
      "to .splus-cache/memory.json; promotable into SPLUS.md for a binding rule.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
      text: z.string().describe("The convention/context to remember, in one sentence."),
      file: z.string().optional().describe("The file/area this convention applies to, if specific."),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ root, text, file }) => {
    const store = new FileMemoryStore(memoryPath(rootOf(root)));
    await store.remember({ kind: "note", text, file });
    return ok(`Noted. Splus will recall this on future reviews of this repo. (Promote it into SPLUS.md to make it a binding rule.)`);
  },
);

// --- index (precise blast-radius tier) -------------------------------------

interface IndexResult {
  status: "indexed" | "unsupported" | "failed";
  message: string;
}

/**
 * For languages whose SCIP indexer is NOT npx-runnable (it needs its own
 * toolchain), return the exact command to run. The engine consumes any
 * `index.scip` regardless of which indexer produced it.
 */
function suggestIndexer(repo: string): string | undefined {
  const out = ".splus-cache/index.scip";
  if (existsSync(join(repo, "go.mod")))
    return `scip-go --output ${out}   (install: go install github.com/sourcegraph/scip-go/cmd/scip-go@latest)`;
  if (existsSync(join(repo, "Cargo.toml")))
    return `rust-analyzer scip . --output ${out}   (ships with rust-analyzer)`;
  if (existsSync(join(repo, "pom.xml")) || existsSync(join(repo, "build.gradle")) || existsSync(join(repo, "build.gradle.kts")))
    return `scip-java index --output ${out}   (see github.com/sourcegraph/scip-java)`;
  return undefined;
}

/** The shared SCIP indexer used by both the `index` tool and `review precise:true`. */
function buildScipIndex(repo: string): IndexResult {
  mkdirSync(join(repo, ".splus-cache"), { recursive: true });
  const out = join(".splus-cache", "index.scip");

  // npx-runnable indexers — no toolchain beyond the project's own deps.
  let indexer: string | undefined;
  if (existsSync(join(repo, "tsconfig.json"))) indexer = "@sourcegraph/scip-typescript";
  else if (existsSync(join(repo, "pyproject.toml")) || existsSync(join(repo, "setup.py")))
    indexer = "@sourcegraph/scip-python";

  if (indexer) {
    const r = spawnSync("npx", ["--yes", indexer, "index", "--output", out], { cwd: repo, encoding: "utf8" });
    if (r.status === 0) {
      return {
        status: "indexed",
        message: `Indexed with ${indexer} → ${join(repo, out)}. Blast radius is now compiler-grade (SCIP).`,
      };
    }
    return {
      status: "failed",
      message:
        `Indexer failed (exit ${r.status ?? "?"}). Ensure the project's deps are installed and it typechecks.\n` +
        (r.stderr || r.stdout || "").slice(0, 600),
    };
  }

  // Other deeply-supported languages (Go, Rust, Java, …): heuristics + complexity
  // + symbol analysis already run; only the precise blast-radius tier needs an
  // index, and its indexer isn't npx-runnable. Point the user at the command.
  const suggestion = suggestIndexer(repo);
  if (suggestion) {
    return {
      status: "unsupported",
      message:
        `Deep analysis (heuristics, complexity, symbols) already runs for this language. ` +
        `For compiler-grade blast radius, build a SCIP index with that language's indexer:\n  ${suggestion}\n` +
        `\`review\` auto-detects .splus-cache/index.scip (or ./index.scip).`,
    };
  }
  return {
    status: "unsupported",
    message:
      "No recognized manifest (tsconfig.json, pyproject.toml, go.mod, Cargo.toml, pom.xml/build.gradle) found — nothing to index.",
  };
}

/** Is there a SCIP index already on disk for this repo? */
function hasScipIndex(repo: string): boolean {
  return existsSync(join(repo, "index.scip")) || existsSync(join(repo, ".splus-cache", "index.scip"));
}

server.registerTool(
  "index",
  {
    title: "Build a SCIP index (precise blast radius)",
    description:
      "Generate a compiler-grade SCIP index so blast-radius resolves precisely (~97% vs the ~60% " +
      "name heuristic). Auto-runs the Sourcegraph indexer for TypeScript/Python (scip-typescript / " +
      "scip-python) and writes .splus-cache/index.scip, which `review` auto-detects. For other " +
      "languages (Go, Rust, Java, …) it returns the exact indexer command to run — the engine " +
      "consumes any index.scip. Needs the project's deps installed; meant for occasional/CI use.",
    inputSchema: {
      root: z.string().optional().describe("Repo root (default: server CWD)."),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ root }) => {
    const r = buildScipIndex(rootOf(root));
    return r.status === "indexed" ? ok(`${r.message} \`review\` will auto-detect it.`) : fail(r.message);
  },
);

// --- boot ------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    "splus-mcp ready (stdio) — local engine, no network · you are the reviewer; " +
      "tools: review, inspect, floor, preferences, report, dismiss, accept, note, recall, mute, learnings, index\n",
  );
}

main().catch((e) => {
  process.stderr.write(`splus-mcp: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
