/**
 * Per-repo behavior, read from `.splus.yml` at the repo root. These are the
 * knobs the web dashboard ultimately writes; the file is the source of truth.
 */
import yaml from "js-yaml";
import type { Context } from "probot";

export interface SplusConfig {
  /** Review automatically on PR open/update. If false, only on @splus mention. */
  auto_review: boolean;
  /** Never auto-review; require an explicit @splus mention. */
  mention_only: boolean;
  /** Post nit-tier findings as inline comments (default: collapsed into summary). */
  show_nits: boolean;
  /** Severity at which the Splus check reports a non-success conclusion. */
  fail_on: "critical" | "high" | "medium" | "low" | "off";
  /** Glob-ish path prefixes to ignore entirely. */
  ignore_paths: string[];
  /** Run the LLM triage layer (needs ANTHROPIC_API_KEY on the server). */
  llm: boolean;
  /** With llm, also run the frontier discovery pass. */
  thorough: boolean;
}

export const DEFAULT_CONFIG: SplusConfig = {
  auto_review: true,
  mention_only: false,
  show_nits: false,
  fail_on: "off", // never block merges by default — advisory only
  ignore_paths: [],
  llm: false, // deterministic-only by default; opt in to LLM triage
  thorough: false,
};

export async function getConfig(ctx: Context): Promise<SplusConfig> {
  try {
    const res = await ctx.octokit.repos.getContent(
      ctx.repo({ path: ".splus.yml" }),
    );
    const data = res.data as { content?: string; encoding?: string };
    if (!data.content) return DEFAULT_CONFIG;
    const raw = Buffer.from(data.content, "base64").toString("utf8");
    const parsed = (yaml.load(raw) ?? {}) as Partial<SplusConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG; // no config file → defaults
  }
}
