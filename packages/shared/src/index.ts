/**
 * @splus/shared — the canonical Finding model (mirrors crates/splus-engine
 * src/model.rs) + a runner that shells out to the Rust engine and validates
 * its JSON. The single shared vocabulary across the CLI and the GitHub App.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

// --- schema (kept in lockstep with the Rust serde model) -------------------

export const Severity = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof Severity>;

export const Tier = z.enum(["must-fix", "concern", "nit"]);
export type Tier = z.infer<typeof Tier>;

export const Category = z.enum([
  "security",
  "supplychain",
  "correctness",
  "maintainability",
  "hygiene",
  "impact",
]);
export type Category = z.infer<typeof Category>;

export const AnchorKind = z.enum([
  "sarif",
  "graph-edge",
  "metric",
  "secret",
  "vuln",
  "heuristic",
]);

export const Anchor = z.object({ kind: AnchorKind, detail: z.string() });

export const Region = z.object({
  start_line: z.number(),
  start_col: z.number(),
  end_line: z.number(),
  end_col: z.number(),
});

export const BlastRadius = z.object({
  symbol: z.string(),
  direct_callers: z.number(),
  transitive_callers: z.number(),
  files_affected: z.array(z.string()),
  crosses_api_boundary: z.boolean(),
  resolution_confidence: z.number(),
  resolution_method: z.string(),
});

export const Finding = z.object({
  id: z.string(),
  rule_id: z.string(),
  category: Category,
  severity: Severity,
  tier: Tier,
  confidence: z.number(),
  file: z.string(),
  region: Region,
  title: z.string(),
  message: z.string(),
  anchor: Anchor,
  introduced: z.boolean(),
  source: z.string(),
  suggestion: z.string().optional(),
  blast_radius: BlastRadius.optional(),
});
export type Finding = z.infer<typeof Finding>;

export const Summary = z.object({
  files_changed: z.number(),
  added_lines: z.number(),
  findings_total: z.number(),
  must_fix: z.number(),
  concern: z.number(),
  nit: z.number(),
  suppressed: z.number(),
  collectors_run: z.array(z.string()),
  adapters_absent: z.array(z.string()),
  notes: z.array(z.string()),
});
export type Summary = z.infer<typeof Summary>;

export const Report = z.object({
  tool: z.string(),
  version: z.string(),
  summary: Summary,
  findings: z.array(Finding),
});
export type Report = z.infer<typeof Report>;

// --- engine runner ---------------------------------------------------------

export type DiffMode =
  | { kind: "staged" }
  | { kind: "working" }
  | { kind: "base"; ref: string }
  | { kind: "all" };

export interface RunOptions {
  root: string;
  mode: DiffMode;
  /** Where to find the engine binary; otherwise auto-resolved. */
  enginePath?: string;
}

/**
 * Locate the `splus-engine` binary: env override → built target dirs walking
 * up from cwd → PATH fallback.
 */
export function resolveEngine(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.SPLUS_ENGINE) return process.env.SPLUS_ENGINE;

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    for (const profile of ["release", "debug"]) {
      const candidate = join(dir, "target", profile, "splus-engine");
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "splus-engine"; // assume on PATH
}

/** Reject a base ref git would parse as an option (e.g. `--output=…`) not a revision. */
function assertSafeRef(ref: string): void {
  if (ref.startsWith("-")) {
    throw new Error(`invalid base ref '${ref}': cannot start with '-'`);
  }
}

function modeArgs(mode: DiffMode): string[] {
  switch (mode.kind) {
    case "staged":
      return ["--staged"];
    case "working":
      return [];
    case "base":
      assertSafeRef(mode.ref);
      return ["--base", mode.ref];
    case "all":
      return ["--all"];
  }
}

/** Run the engine and return the validated JSON Report. */
export async function runEngine(opts: RunOptions): Promise<Report> {
  const bin = resolveEngine(opts.enginePath);
  const args = [
    "review",
    "--root",
    resolve(opts.root),
    "--format",
    "json",
    ...modeArgs(opts.mode),
  ];
  const { stdout, stderr, code } = await exec(bin, args);
  // The engine prints a JSON report on success (exit 0) and on the --fail-on
  // path (exit 1); a handled error exits 2 and a panic exits 101 — both write the
  // reason to stderr and nothing parseable to stdout. Key off "is there JSON?"
  // rather than only exit 2, so a crash surfaces its real cause instead of a
  // cryptic "Unexpected end of JSON input" (which the MCP layer otherwise
  // misreports as a missing binary), and stderr is never silently discarded.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `splus-engine failed (exit ${code}): ${stderr.trim() || stdout.slice(0, 200) || "no output"}`,
    );
  }
  return Report.parse(parsed);
}

/** The on-demand questions the engine answers via `inspect`. */
export type InspectKind =
  | "definition"
  | "callers"
  | "blast_radius"
  | "complexity"
  | "exports"
  | "imports";

export interface InspectOptions {
  root: string;
  kind: InspectKind;
  /** Symbol name (definition/callers/blast_radius) or file path (complexity/exports/imports). */
  target: string;
  /** Pin the defining file for a symbol query (disambiguates same-named symbols). */
  file?: string;
  enginePath?: string;
}

/**
 * The engine "on tap": answer one code-intelligence question as parsed JSON.
 * Mirrors `runEngine`'s honest failure handling (surface engine stderr, never a
 * cryptic JSON-parse error).
 */
export async function inspect(opts: InspectOptions): Promise<unknown> {
  const bin = resolveEngine(opts.enginePath);
  const args = [
    "inspect",
    "--root",
    resolve(opts.root),
    "--kind",
    opts.kind,
    "--target",
    opts.target,
    ...(opts.file ? ["--file", opts.file] : []),
  ];
  const { stdout, stderr, code } = await exec(bin, args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `splus-engine inspect failed (exit ${code}): ${stderr.trim() || stdout.slice(0, 200) || "no output"}`,
    );
  }
}

function exec(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((res, rej) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", rej);
    child.on("close", (code) => res({ stdout, stderr, code: code ?? 0 }));
  });
}

/**
 * The set of files git considers changed for a given mode — the real change
 * surface. Used to drive a reviewer (human or LLM discovery pass) over every
 * changed file, including ones the deterministic engine produced no finding for.
 * `--diff-filter=d` excludes deletions (nothing left to read). Returns [] on error.
 */
export function listChangedFiles(root: string, mode: DiffMode): string[] {
  if (mode.kind === "base") assertSafeRef(mode.ref);
  const args =
    mode.kind === "staged"
      ? ["diff", "--cached", "--name-only", "--diff-filter=d"]
      : mode.kind === "base"
        ? ["diff", "--name-only", "--diff-filter=d", `${mode.ref}...HEAD`, "--"]
        : mode.kind === "all"
          ? ["ls-files"]
          : ["diff", "--name-only", "--diff-filter=d", "HEAD"];
  const r = spawnSync("git", args, {
    cwd: resolve(root),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return [];
  return (r.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The unified diff text for a mode — the same change surface `listChangedFiles`
 * names, as hunks. Mode `all` has no diff (the whole repo is "the change").
 * Returns "" on any git failure: callers treat the diff as enrichment, never load-bearing.
 */
export function diffText(root: string, mode: DiffMode): string {
  if (mode.kind === "all") return "";
  if (mode.kind === "base") assertSafeRef(mode.ref);
  const args =
    mode.kind === "staged"
      ? ["diff", "--cached"]
      : mode.kind === "base"
        ? ["diff", `${mode.ref}...HEAD`, "--"]
        : ["diff", "HEAD"];
  const r = spawnSync("git", args, {
    cwd: resolve(root),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

/** New-side line ranges per file from a unified diff's hunk headers. */
export function changedLineRanges(diff: string): Map<string, Array<[number, number]>> {
  const map = new Map<string, Array<[number, number]>>();
  let file = "";
  for (const line of diff.split("\n")) {
    const f = line.match(/^\+\+\+ b\/(.+)/);
    if (f) {
      file = f[1] ?? "";
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] !== undefined ? Number(h[2]) : 1;
      const arr = map.get(file) ?? [];
      arr.push([start, start + Math.max(count, 1) - 1]);
      map.set(file, arr);
    }
  }
  return map;
}

/**
 * The diff's change surface as exported-symbol names: for each changed file, ask
 * the engine for its exports (tree-sitter) and keep the ones whose body overlaps
 * a diff hunk. One line per file: `path: symbolA, symbolB`. This is deterministic
 * AIM for a reviewer — "these are the contracts the change touches; trace each
 * into its callers." Best-effort: any engine failure just drops that file.
 */
export async function changedExportedSymbols(root: string, files: string[], diff: string): Promise<string[]> {
  const ranges = changedLineRanges(diff);
  const out: string[] = [];
  for (const file of files) {
    const fileRanges = ranges.get(file);
    if (!fileRanges?.length) continue;
    let exports: Array<{ name: string; line: number; kind: string }>;
    try {
      const r = (await inspect({ root, kind: "exports", target: file })) as {
        exports?: Array<{ name: string; line: number; kind: string }>;
      };
      exports = (r.exports ?? []).filter((e) => e.line > 0).sort((a, b) => a.line - b.line);
    } catch {
      continue;
    }
    const touched: string[] = [];
    for (let i = 0; i < exports.length; i++) {
      const cur = exports[i];
      if (!cur) continue;
      // Approximate body span: from this export's line to just before the next.
      const start = cur.line;
      const end = exports[i + 1] ? exports[i + 1]!.line - 1 : Number.MAX_SAFE_INTEGER;
      if (fileRanges.some(([a, b]) => b >= start && a <= end)) touched.push(cur.name);
    }
    if (touched.length) out.push(`${file}: ${touched.join(", ")}`);
  }
  return out;
}

// The per-repo review contract (`SPLUS.md`): loader + binding policy.
export * from "./splusMd.js";
export * from "./prReview.js";
