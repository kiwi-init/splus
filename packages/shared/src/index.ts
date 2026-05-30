/**
 * @splus/shared — the canonical Finding model (mirrors crates/splus-engine
 * src/model.rs) + a runner that shells out to the Rust engine and validates
 * its JSON. The single shared vocabulary across the CLI and the GitHub App.
 */
import { spawn } from "node:child_process";
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
  | { kind: "base"; ref: string };

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

function modeArgs(mode: DiffMode): string[] {
  switch (mode.kind) {
    case "staged":
      return ["--staged"];
    case "working":
      return [];
    case "base":
      return ["--base", mode.ref];
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
  const { stdout, code } = await exec(bin, args);
  if (code === 2) {
    throw new Error(`splus-engine failed (exit 2):\n${stdout}`);
  }
  const parsed: unknown = JSON.parse(stdout);
  return Report.parse(parsed);
}

/** Stream the engine's pretty output straight to this process (CLI default). */
export function runEnginePretty(opts: RunOptions & { failOn?: string; noColor?: boolean }): Promise<number> {
  const bin = resolveEngine(opts.enginePath);
  const args = [
    "review",
    "--root",
    resolve(opts.root),
    "--format",
    "pretty",
    ...modeArgs(opts.mode),
    ...(opts.failOn ? ["--fail-on", opts.failOn] : []),
    ...(opts.noColor ? ["--no-color"] : []),
  ];
  return new Promise((res) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("close", (code) => res(code ?? 0));
    child.on("error", (e) => {
      process.stderr.write(`splus: cannot run engine (${bin}): ${String(e)}\n`);
      res(2);
    });
  });
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

/** Map our severities to a numeric rank (mirrors the engine). */
export function severityRank(s: Severity): number {
  return { critical: 4, high: 3, medium: 2, low: 1, info: 0 }[s];
}

/** Does the report contain a finding at/above the given severity? */
export function exceedsThreshold(report: Report, failOn: Severity): boolean {
  const t = severityRank(failOn);
  return report.findings.some((f) => severityRank(f.severity) >= t);
}
