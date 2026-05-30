/**
 * The core PR review flow for the GitHub App:
 *   clone head → run the deterministic engine (base..head) → post ONE batched
 *   review with inline comments + suggestions → set a neutral Checks gate.
 *
 * Deterministic-only in this pass (no LLM). Every comment is anchored.
 */
import { runEngine, type Finding, type Report } from "@splus/shared";
import { triage } from "@splus/triage";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "probot";
import type { SplusConfig } from "./config.js";

/** GitHub caps the practical number of inline comments; keep reviews focused. */
const MAX_INLINE_COMMENTS = 40;

interface PullRef {
  number: number;
  base: { sha: string };
  head: { sha: string };
}

export async function reviewPR(
  ctx: Context,
  pr: PullRef,
  cfg: SplusConfig,
): Promise<void> {
  const { owner, repo } = ctx.repo();
  const token = await installationToken(ctx);
  const dir = mkdtempSync(join(tmpdir(), "splus-"));

  try {
    cloneAtHead(dir, token, owner, repo, pr);

    const report = await runEngine({
      root: dir,
      mode: { kind: "base", ref: pr.base.sha },
    });

    // The LLM layer is consistent with the CLI: it only RE-ranks/suppresses and
    // explains the deterministic candidates. Opt-in + key-gated; never blocks.
    let findings: Finding[] = report.findings;
    const rationale = new Map<string, string>();
    if (cfg.llm && process.env.ANTHROPIC_API_KEY) {
      try {
        const t = await triage(report, { root: dir, thorough: cfg.thorough });
        findings = t.findings;
        for (const f of t.findings) rationale.set(f.id, f.rationale);
      } catch (err) {
        ctx.log?.warn?.(`Splus LLM triage failed; using deterministic findings: ${String(err)}`);
      }
    }

    const visible = findings.filter(
      (f) =>
        !cfg.ignore_paths.some((p) => f.file.startsWith(p)) &&
        (cfg.show_nits || f.tier !== "nit"),
    );

    const inline = visible.slice(0, MAX_INLINE_COMMENTS).map((f) => ({
      path: f.file,
      line: f.region.start_line,
      side: "RIGHT" as const,
      body: renderComment(f, rationale.get(f.id)),
    }));

    await postReview(ctx, pr.number, report, visible, inline);
    await postCheck(ctx, pr.head.sha, report, cfg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- git / auth ------------------------------------------------------------

async function installationToken(ctx: Context): Promise<string> {
  const auth = (await ctx.octokit.auth({ type: "installation" })) as {
    token: string;
  };
  return auth.token;
}

function cloneAtHead(
  dir: string,
  token: string,
  owner: string,
  repo: string,
  pr: PullRef,
): void {
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["init", "-q", dir], { stdio: "pipe" });
  git(["remote", "add", "origin", url]);
  // Fetch just the two commits we diff between (base merge-base + head).
  git(["fetch", "--no-tags", "--depth", "50", "origin", pr.base.sha, pr.head.sha]);
  git(["checkout", "-q", pr.head.sha]);
}

// --- posting ---------------------------------------------------------------

async function postReview(
  ctx: Context,
  pull_number: number,
  report: Report,
  visible: Finding[],
  inline: Array<{ path: string; line: number; side: "RIGHT"; body: string }>,
): Promise<void> {
  const body = summaryBody(report, visible.length, inline.length);
  try {
    await ctx.octokit.pulls.createReview(
      ctx.repo({ pull_number, event: "COMMENT", body, comments: inline }),
    );
  } catch {
    // Some inline positions can be rejected (e.g. lines outside the unified
    // diff window). Fall back to a single summary review — never silently drop.
    await ctx.octokit.pulls.createReview(
      ctx.repo({
        pull_number,
        event: "COMMENT",
        body:
          body +
          "\n\n_(Inline anchoring was rejected by GitHub for some findings; see the summary above.)_",
      }),
    );
  }
}

async function postCheck(
  ctx: Context,
  head_sha: string,
  report: Report,
  cfg: SplusConfig,
): Promise<void> {
  const s = report.summary;
  // Advisory by default: neutral when there are must-fixes, success otherwise.
  // Only a configured fail_on turns this into an actual failure.
  let conclusion: "success" | "neutral" | "failure" = s.must_fix > 0 ? "neutral" : "success";
  if (cfg.fail_on !== "off" && blocks(report, cfg.fail_on)) {
    conclusion = "failure";
  }
  await ctx.octokit.checks.create(
    ctx.repo({
      name: "Splus",
      head_sha,
      status: "completed",
      conclusion,
      output: {
        title: `${s.must_fix} must-fix · ${s.concern} concern · ${s.nit} nit`,
        summary: summaryBody(report, report.findings.length, 0),
      },
    }),
  );
}

function blocks(report: Report, failOn: SplusConfig["fail_on"]): boolean {
  const rank: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
  const t = rank[failOn] ?? 99;
  return report.findings.some((f) => (rank[f.severity] ?? 0) >= t);
}

// --- rendering -------------------------------------------------------------

const ICON: Record<string, string> = {
  critical: "🔴",
  high: "🔴",
  medium: "🟠",
  low: "🔵",
  info: "⚪️",
};

function renderComment(f: Finding, rationale?: string): string {
  const lines: string[] = [];
  lines.push(`${ICON[f.severity] ?? "•"} **${f.title}** \`${f.rule_id}\` · ${Math.round(f.confidence * 100)}% confidence`);
  lines.push("");
  lines.push(rationale ?? f.message);
  if (f.blast_radius) {
    const b = f.blast_radius;
    lines.push("");
    lines.push(
      `> **Blast radius:** ${b.direct_callers} direct / ${b.transitive_callers} transitive caller(s) across ${b.files_affected.length} file(s)` +
        (b.crosses_api_boundary ? " · crosses API boundary" : "") +
        ` · _${Math.round(b.resolution_confidence * 100)}% resolution confidence (${b.resolution_method})_`,
    );
  }
  if (f.suggestion) {
    lines.push("");
    lines.push("```suggestion");
    lines.push(f.suggestion);
    lines.push("```");
  }
  lines.push("");
  lines.push(`<sub>Splus · anchored in \`${f.anchor.kind}\`: ${f.anchor.detail}</sub>`);
  return lines.join("\n");
}

function summaryBody(report: Report, visible: number, inlineCount: number): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push("## Splus Review");
  lines.push("");
  lines.push(
    `**${s.must_fix}** must-fix · **${s.concern}** concern · **${s.nit}** nit · ` +
      `${s.files_changed} file(s), ${s.added_lines} added line(s) reviewed (clean-as-you-code).`,
  );
  if (inlineCount > 0 && inlineCount < visible) {
    lines.push("");
    lines.push(`> Showing the top ${inlineCount} of ${visible} findings inline.`);
  }
  if (report.findings.length === 0) {
    lines.push("");
    lines.push("✅ No issues on changed lines.");
  }
  if (s.adapters_absent.length > 0) {
    lines.push("");
    lines.push(`<sub>Optional deep adapters not enabled: ${s.adapters_absent.join(", ")}.</sub>`);
  }
  for (const note of s.notes) {
    lines.push("");
    lines.push(`> ⚠️ ${note}`);
  }
  lines.push("");
  lines.push("<sub>Deterministic, diff-scoped, zero-inference. Every comment is anchored. Reply to dismiss and Splus learns.</sub>");
  return lines.join("\n");
}
