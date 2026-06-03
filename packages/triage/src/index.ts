/**
 * @splus/triage — the LLM layer, strictly downstream of the deterministic engine.
 *
 * The deterministic pipeline decides WHAT is worth a comment; the LLM decides only
 * whether a senior reviewer would actually flag it, explains it, and suggests a fix.
 * Every candidate already carries a deterministic anchor — the model never free-scans.
 *
 * Triage:    Haiku 4.5, forced tool-use structured output, sharded by file, cached rubric.
 * Discovery: Opus 4.8 (opt-in / thorough), finds logic & security bugs determinism can't,
 *            and MUST cite a location inside the changed files.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Report, Severity } from "@splus/shared";
import { Severity as SeverityEnum, Category as CategoryEnum } from "@splus/shared";

export const TRIAGE_MODEL = "claude-haiku-4-5";
export const DISCOVERY_MODEL = "claude-opus-4-8";

/** Minimal structural shape of the Anthropic client — lets us inject a mock. */
export interface LLMClient {
  messages: {
    create(body: Record<string, unknown>): Promise<LLMResponse>;
  };
}
interface LLMResponse {
  content: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface TriageOptions {
  /** Repo root, to read code context for each finding. */
  root: string;
  /** Run the discovery pass (frontier model) for logic/security bugs. Default false. */
  thorough?: boolean;
  /**
   * Run the adversarial VERIFY stage over LLM-discovered findings: a skeptical
   * pass that tries to refute each one against the cited code and drops the ones
   * that don't hold up. The precision gate that keeps discovery from leaking the
   * plausible-but-wrong comments that sink reviewer trust. Default: follows `thorough`.
   */
  verify?: boolean;
  verifyModel?: string;
  /**
   * The full set of changed files (the real change surface) for the discovery
   * pass to read. Discovery's whole job is to find bugs determinism missed, so it
   * must look at changed files that produced NO deterministic finding — not only
   * the files that did. When omitted, falls back to files-with-findings (degraded,
   * for backward compatibility), and a note is emitted so the gap is visible.
   */
  changedFiles?: string[];
  /**
   * The unified diff of the change (added lines are where bugs live). When given,
   * the discovery pass reviews the DIFF — not whole files blind — which is the
   * single biggest recall lever. Without it, discovery falls back to full files.
   */
  diff?: string;
  /** Max concurrent LLM calls. Default 5. */
  concurrency?: number;
  /** Override models. */
  triageModel?: string;
  discoveryModel?: string;
  /** Inject a client (tests) or an API key; otherwise reads ANTHROPIC_API_KEY. */
  client?: LLMClient;
  apiKey?: string;
}

export interface TriagedFinding extends Finding {
  /** LLM decision. */
  verdict: "keep" | "suppress";
  /** LLM's calibrated confidence this is worth flagging (0..1). */
  llmConfidence: number;
  /** One-paragraph senior-reviewer rationale. */
  rationale: string;
  /** True for findings the LLM discovered (no deterministic anchor). */
  llmOnly?: boolean;
}

export interface TriagedReport extends Omit<Report, "findings"> {
  /** Findings the LLM kept (a senior reviewer would flag these). */
  findings: TriagedFinding[];
  /** Findings the LLM judged not worth a comment, with reasons (auditable). */
  suppressed: TriagedFinding[];
  llm: {
    triageModel: string;
    discoveryModel?: string;
    verifyModel?: string;
    triaged: number;
    kept: number;
    suppressed: number;
    discovered: number;
    /** Discovered findings that survived the adversarial VERIFY stage. */
    verified: number;
    /** Discovered findings dropped by VERIFY (refuted against the code). */
    refuted: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
}

const SYSTEM_RUBRIC = `You are Splus, a precision-first senior code reviewer. A deterministic engine has already surfaced candidate findings on a pull request, each grounded in a reproducible anchor (a secret pattern, a computed metric, a cross-file graph edge, a SARIF result, or a syntactic heuristic). Your job is NOT to find issues — it is to decide, for each candidate, whether a thoughtful senior reviewer would actually leave this as a comment on this PR.

Decide keep vs suppress for every candidate. Optimize for SIGNAL: the cost of a noisy comment (eroded trust) is higher than the cost of one missed nit.

SUPPRESS when the finding is technically real but not worth a reviewer's comment, e.g.:
- Test fixtures, examples, mocks, or *.example files (a "secret" in test data or an .env.example placeholder is not a leak).
- Intentional, idiomatic patterns for the file's role (a console.log in a CLI entry point, a print in a script, an eval behind a trusted constant).
- Pure style/preference with no correctness or maintainability impact.
- A metric finding (e.g. complexity) on code that is inherently and irreducibly complex (a parser, a state machine) where splitting would not help.

KEEP when a senior reviewer would genuinely want it addressed before merge: real secrets, real injection/traversal sinks reachable from input, breaking cross-file changes, meaningful complexity regressions in ordinary code, focused/skipped tests left in, merge-conflict markers.

For each candidate return: the id, decision (keep|suppress), a confidence 0..1 (your calibrated belief a senior reviewer would flag it), a crisp one- to three-sentence rationale, and — only when an obvious, correct fix exists — a committable suggestion (the replacement code for the cited line(s), no diff markers). Do not invent suggestions you are unsure about.

Be concise. Never fabricate. Ground every rationale in the provided code and anchor.`;

const TRIAGE_TOOL = {
  name: "submit_triage",
  description: "Submit keep/suppress verdicts for every candidate finding.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The candidate's id, verbatim." },
            decision: { type: "string", enum: ["keep", "suppress"] },
            confidence: { type: "number", description: "0..1" },
            rationale: { type: "string" },
            suggestion: { type: "string", description: "Replacement code, or empty string." },
          },
          required: ["id", "decision", "confidence", "rationale"],
        },
      },
    },
    required: ["verdicts"],
  },
} as const;

const DISCOVERY_TOOL = {
  name: "report_findings",
  description:
    "Report additional real bugs the deterministic engine could not find. Only logic/security/correctness issues, each citing a line inside the provided changed files.",
  input_schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            line: { type: "number" },
            title: { type: "string" },
            severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
            category: {
              type: "string",
              enum: ["security", "correctness", "maintainability"],
            },
            rationale: { type: "string" },
            suggestion: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["file", "line", "title", "severity", "category", "rationale", "confidence"],
        },
      },
    },
    required: ["findings"],
  },
} as const;

const VERIFY_SYSTEM = `You are a SKEPTICAL senior reviewer doing the final gate before comments are posted on a pull request. Each candidate below is a finding another reviewer plans to post. Your job is to REFUTE it: read the cited code and decide whether the claimed issue is real and actually demonstrated by that exact location.

A reviewer's credibility dies from wrong comments, so be strict. Mark verified=false when:
- the cited line does not clearly demonstrate the claimed issue,
- the "bug" is actually handled elsewhere in the shown code (guard, await, try/except, validation),
- the claim is speculative ("could", "might", "if untrusted") without evidence in the code,
- you are not confident the comment would survive a maintainer's pushback.

Only verified=true when a competent maintainer would agree the issue is real and worth fixing. Prefer dropping a doubtful comment over posting a wrong one. Return a verdict for every candidate id.`;

const VERIFY_TOOL = {
  name: "submit_verifications",
  description: "For each candidate, decide whether it holds up against the actual code.",
  input_schema: {
    type: "object",
    properties: {
      verifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The candidate's id, verbatim." },
            verified: { type: "boolean", description: "true ONLY if the cited code clearly demonstrates the issue." },
            confidence: { type: "number", description: "0..1 belief the issue is real." },
            reason: { type: "string", description: "Why it holds up, or why it was refuted." },
          },
          required: ["id", "verified", "confidence", "reason"],
        },
      },
    },
    required: ["verifications"],
  },
} as const;

interface Verdict {
  id: string;
  decision: "keep" | "suppress";
  confidence: number;
  rationale: string;
  suggestion?: string;
}

interface Verification {
  id: string;
  verified: boolean;
  confidence: number;
  reason: string;
}

/** Triage (and optionally discover) findings, returning an enriched report. */
export async function triage(report: Report, opts: TriageOptions): Promise<TriagedReport> {
  const client = resolveClient(opts);
  const triageModel = opts.triageModel ?? TRIAGE_MODEL;
  const concurrency = opts.concurrency ?? 5;

  const usage = { input: 0, output: 0, cached: 0 };
  const accUsage = (r: LLMResponse) => {
    usage.input += r.usage?.input_tokens ?? 0;
    usage.output += r.usage?.output_tokens ?? 0;
    usage.cached += r.usage?.cache_read_input_tokens ?? 0;
  };

  // --- TRIAGE: shard by file ---
  const byFile = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  const verdicts = new Map<string, Verdict>();
  await mapLimit([...byFile.entries()], concurrency, async ([file, findings]) => {
    const res = await client.messages.create({
      model: triageModel,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_RUBRIC, cache_control: { type: "ephemeral" } }],
      tools: [TRIAGE_TOOL],
      tool_choice: { type: "tool", name: "submit_triage" },
      messages: [{ role: "user", content: triageUserPrompt(opts.root, file, findings) }],
    });
    accUsage(res);
    for (const v of parseTool<{ verdicts: Verdict[] }>(res)?.verdicts ?? []) {
      verdicts.set(v.id, v);
    }
  });

  const kept: TriagedFinding[] = [];
  const suppressed: TriagedFinding[] = [];
  for (const f of report.findings) {
    const v = verdicts.get(f.id);
    // Fail open: if the model returned no verdict for a candidate, KEEP it
    // (never silently drop a deterministic finding).
    const decision = v?.decision ?? "keep";
    const enriched: TriagedFinding = {
      ...f,
      verdict: decision,
      llmConfidence: v?.confidence ?? f.confidence,
      rationale: v?.rationale ?? "(no LLM verdict — kept by default)",
      suggestion: f.suggestion ?? (v?.suggestion && v.suggestion.trim() ? v.suggestion : undefined),
    };
    (decision === "suppress" ? suppressed : kept).push(enriched);
  }

  // --- DISCOVERY (opt-in) ---
  let discovered = 0;
  let discoveryModel: string | undefined;
  const extraNotes: string[] = [];
  if (opts.thorough) {
    discoveryModel = opts.discoveryModel ?? DISCOVERY_MODEL;
    const { files, notes } = selectDiscoverySurface(opts.changedFiles, [...byFile.keys()]);
    extraNotes.push(...notes);
    const news = await discover(client, discoveryModel, opts.root, files, opts.diff, accUsage);
    discovered = news.length;
    kept.push(...news);
  }

  // --- VERIFY (adversarial precision gate) ---
  // Engine-anchored findings are already grounded — we trust them. The LLM's
  // free-form discoveries are where plausible-but-wrong comments come from, so a
  // skeptical pass tries to refute each one against the cited code and drops the
  // ones that don't survive. This is the lever that buys precision over a bare
  // model: it never ADDS noise, it only removes it.
  let verifyModel: string | undefined;
  let verified = 0;
  let refuted = 0;
  const doVerify = opts.verify ?? opts.thorough ?? false;
  const toVerify = kept.filter((f) => f.llmOnly);
  if (doVerify && toVerify.length > 0) {
    verifyModel = opts.verifyModel ?? discoveryModel ?? DISCOVERY_MODEL;
    const vmap = await verifyFindings(client, verifyModel, opts.root, toVerify, accUsage, concurrency);
    const survivors: TriagedFinding[] = [];
    for (const f of kept) {
      if (!f.llmOnly) {
        survivors.push(f);
        continue;
      }
      const v = vmap.get(f.id);
      // Strict gate: drop only on an explicit refutation. A missing verdict
      // fails OPEN (keep) so a flaky verify call can't silently swallow findings.
      if (v && v.verified === false) {
        refuted++;
        suppressed.push({
          ...f,
          verdict: "suppress",
          rationale: `failed verification: ${v.reason}`,
        });
      } else {
        verified++;
        survivors.push(v ? { ...f, llmConfidence: Math.min(f.llmConfidence, v.confidence) } : f);
      }
    }
    kept.length = 0;
    kept.push(...survivors);
  }

  kept.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.llmConfidence - a.llmConfidence);

  return {
    tool: report.tool,
    version: report.version,
    summary: {
      ...report.summary,
      suppressed: suppressed.length,
      notes: [...report.summary.notes, ...extraNotes],
    },
    findings: kept,
    suppressed,
    llm: {
      triageModel,
      discoveryModel,
      verifyModel,
      triaged: report.findings.length,
      kept: kept.length,
      suppressed: suppressed.length,
      discovered,
      verified,
      refuted,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cached,
    },
  };
}

// --- discovery ---

/** How many files the (cost-bounded) discovery pass deep-reads. */
const DISCOVERY_FILE_CAP = 8;

/**
 * The files the discovery pass should read — the real change surface (every
 * changed file, not just the ones the engine already flagged), capped for cost —
 * plus any disclosure notes (degraded scope when no surface was supplied, or
 * cost-cap truncation). Kept out of `triage()` so that function stays reviewable.
 * See the `changedFiles` docs on TriageOptions for why clean files must be read.
 */
function selectDiscoverySurface(
  changedFiles: string[] | undefined,
  filesWithFindings: string[],
): { files: string[]; notes: string[] } {
  const notes: string[] = [];
  const haveSurface = (changedFiles?.length ?? 0) > 0;
  const surface = haveSurface ? changedFiles! : filesWithFindings;
  if (!haveSurface) {
    notes.push(
      "Discovery scoped to files-with-findings only (no changedFiles supplied) — clean changed files were not deep-reviewed.",
    );
  }
  if (surface.length > DISCOVERY_FILE_CAP) {
    notes.push(`Discovery deep-reviewed ${DISCOVERY_FILE_CAP} of ${surface.length} changed file(s) (cost cap).`);
  }
  return { files: surface.slice(0, DISCOVERY_FILE_CAP), notes };
}

async function discover(
  client: LLMClient,
  model: string,
  root: string,
  files: string[],
  diff: string | undefined,
  accUsage: (r: LLMResponse) => void,
): Promise<TriagedFinding[]> {
  const blocks = files
    .map((f) => {
      const src = readFileSafe(join(root, f));
      if (!src) return null;
      return `### ${f}\n${numberLines(src)}`;
    })
    .filter(Boolean)
    .join("\n\n");
  if (!blocks && !diff) return [];

  // The DIFF is the focus (bugs live in changed lines); the full files are
  // context for reasoning. Lead with the diff so the model reviews the change,
  // not the whole file blind — the single biggest recall lever.
  const userContent = diff
    ? `Review this DIFF. The added/changed lines (\`+\`) are where bugs are most likely; cite line numbers from the FULL FILES below.\n\n=== DIFF (the change under review) ===\n${diff.slice(0, 60000)}\n\n=== FULL FILES (numbered, for context + line numbers) ===\n${blocks}`
    : `Changed files:\n\n${blocks}`;

  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text:
          "You are Splus in deep-review mode, reviewing the NEW/changed code in a diff. Find EVERY plausible bug the change introduces: logic errors, off-by-one, missing await/unhandled error paths, null/undefined, broken invariants, resource leaks, race conditions, security (injection, SSRF, path-traversal, authz/IDOR, unsafe deserialization, secrets), breaking API/signature changes, and intent/spec mismatches (code that doesn't do what its name/comment/PR claims). " +
          "Prioritize RECALL: a separate verification pass removes false positives, so err toward flagging anything a careful senior reviewer might raise — but only about the CHANGED code, and each finding MUST cite a real line number from the provided files. Don't flag pre-existing code the diff didn't touch.",
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [DISCOVERY_TOOL],
    tool_choice: { type: "tool", name: "report_findings" },
    messages: [{ role: "user", content: userContent }],
  });
  accUsage(res);

  const out: TriagedFinding[] = [];
  const fileSet = new Set(files);
  for (const d of parseTool<{ findings: DiscoveryItem[] }>(res)?.findings ?? []) {
    if (!fileSet.has(d.file)) continue; // must cite a provided file (anti-hallucination)
    // The model is tool-constrained but not schema-validated on the client side,
    // so a stray severity/category would make severityRank() return undefined and
    // silently bucket the finding as a nit. Validate against the canonical enums.
    const severity: Severity = SeverityEnum.safeParse(d.severity).success ? (d.severity as Severity) : "medium";
    const category = (CategoryEnum.safeParse(d.category).success ? d.category : "correctness") as TriagedFinding["category"];
    out.push({
      id: `llm:${d.file}:${d.line}:${hashTitle(d.title)}`,
      rule_id: `discovery.${category}`,
      category,
      severity,
      tier: severityRank(severity) >= 3 ? "must-fix" : severityRank(severity) === 2 ? "concern" : "nit",
      confidence: d.confidence,
      file: d.file,
      region: { start_line: d.line, start_col: 0, end_line: d.line, end_col: 0 },
      title: d.title,
      message: d.rationale,
      anchor: { kind: "heuristic", detail: "llm-discovery (no deterministic anchor)" },
      introduced: true,
      source: "llm-discovery",
      suggestion: d.suggestion && d.suggestion.trim() ? d.suggestion : undefined,
      verdict: "keep",
      llmConfidence: d.confidence,
      rationale: d.rationale,
      llmOnly: true,
    });
  }
  return out;
}

interface DiscoveryItem {
  file: string;
  line: number;
  title: string;
  severity: string;
  category: string;
  rationale: string;
  suggestion?: string;
  confidence: number;
}

// --- verify (adversarial precision gate) ---

/**
 * Skeptically re-check each discovered finding against the cited code, sharded by
 * file. Returns a verdict per finding id; callers drop only explicit refutations.
 */
async function verifyFindings(
  client: LLMClient,
  model: string,
  root: string,
  findings: TriagedFinding[],
  accUsage: (r: LLMResponse) => void,
  concurrency: number,
): Promise<Map<string, Verification>> {
  const byFile = new Map<string, TriagedFinding[]>();
  for (const f of findings) {
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }
  const out = new Map<string, Verification>();
  await mapLimit([...byFile.entries()], concurrency, async ([file, fs]) => {
    const res = await client.messages.create({
      model,
      max_tokens: 2048,
      system: [{ type: "text", text: VERIFY_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools: [VERIFY_TOOL],
      tool_choice: { type: "tool", name: "submit_verifications" },
      messages: [{ role: "user", content: verifyPrompt(root, file, fs) }],
    });
    accUsage(res);
    for (const v of parseTool<{ verifications: Verification[] }>(res)?.verifications ?? []) {
      out.set(v.id, v);
    }
  });
  return out;
}

function verifyPrompt(root: string, file: string, findings: TriagedFinding[]): string {
  const src = readFileSafe(join(root, file));
  const lines = src ? src.split("\n") : [];
  const parts: string[] = [`File: ${file}`, ""];
  for (const f of findings) {
    parts.push(`--- candidate ${f.id} ---`);
    parts.push(`claim (${f.severity} ${f.category}): ${f.title}`);
    parts.push(`rationale: ${f.rationale}`);
    parts.push("code:");
    parts.push(contextWindow(lines, f.region.start_line, 8));
    parts.push("");
  }
  parts.push("Refute or confirm every candidate id above.");
  return parts.join("\n");
}

// --- prompt construction ---

function triageUserPrompt(root: string, file: string, findings: Finding[]): string {
  const src = readFileSafe(join(root, file));
  const lines = src ? src.split("\n") : [];
  const parts: string[] = [`File: ${file}`, ""];
  for (const f of findings) {
    parts.push(`--- candidate ${f.id} ---`);
    parts.push(
      `rule: ${f.rule_id} | severity: ${f.severity} | category: ${f.category} | anchor(${f.anchor.kind}): ${f.anchor.detail}`,
    );
    parts.push(`engine message: ${f.message}`);
    if (f.blast_radius) {
      parts.push(
        `blast radius: ${f.blast_radius.direct_callers} direct caller(s), resolution confidence ${f.blast_radius.resolution_confidence}`,
      );
    }
    parts.push("code:");
    parts.push(contextWindow(lines, f.region.start_line, 6));
    parts.push("");
  }
  parts.push("Return a verdict for every candidate id above.");
  return parts.join("\n");
}

function contextWindow(lines: string[], line: number, radius: number): string {
  if (lines.length === 0) return "(source unavailable)";
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const marker = i === line ? ">" : " ";
    out.push(`${marker} ${i}\t${lines[i - 1] ?? ""}`);
  }
  return out.join("\n");
}

function numberLines(src: string): string {
  return src
    .split("\n")
    .map((l, i) => `${i + 1}\t${l}`)
    .join("\n");
}

// --- helpers ---

function resolveClient(opts: TriageOptions): LLMClient {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Splus triage needs an Anthropic API key. Set ANTHROPIC_API_KEY (the deterministic engine works without one).",
    );
  }
  return new Anthropic({ apiKey }) as unknown as LLMClient;
}

function parseTool<T>(res: LLMResponse): T | null {
  const block = res.content.find((b) => b.type === "tool_use");
  return (block?.input as T) ?? null;
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function severityRank(s: Severity): number {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[s];
}

function hashTitle(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Provider adapters (OpenAI GPT-5.5 hosted judge; selector). The Anthropic/local
// path above is untouched — these are additive.
export { createOpenAIClient } from "./openai.js";
export { createLLMClient } from "./provider.js";
export { createClaudeCliClient } from "./claude-cli.js";
