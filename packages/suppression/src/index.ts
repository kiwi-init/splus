/**
 * @splus/suppression — the learned, per-repo noise filter (the compounding moat).
 *
 * Three tiers, cheapest first:
 *   1. exact      — the same finding (by fingerprint) was dismissed before.
 *   2. rule-mute  — the whole rule was muted for this repo.
 *   3. semantic   — cosine-similar to a dismissed finding (feature-hash embedder).
 *
 * Scoped per repo (one store = one repo's learnings) to avoid cross-team
 * contamination — the exact trap that makes competitors noisy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding, Report } from "@splus/shared";
import { cosine, hashEmbedder, type Embedder } from "./embed.js";

export { hashEmbedder, cosine, type Embedder } from "./embed.js";

/** A dismissal/feedback record. */
export interface DismissedEntry {
  /** Finding fingerprint (for exact match); ignored for rule-scope entries. */
  fingerprint: string;
  rule_id: string;
  /** Text used for semantic comparison: `${rule_id} ${title} ${message}`. */
  text: string;
  /** What we learned from. */
  signal: "dismissed" | "downvoted" | "muted";
  /** "fingerprint" = this specific finding; "rule" = every finding of this rule. */
  scope: "fingerprint" | "rule";
  /** ISO timestamp (caller-supplied; the deterministic engine never stamps time). */
  at: string;
}

export interface Candidate {
  fingerprint: string;
  rule_id: string;
  text: string;
}

export interface Decision {
  suppress: boolean;
  reason: string;
  kind?: "exact" | "rule" | "semantic";
  similarity?: number;
}

export interface SuppressionStore {
  evaluate(candidates: Candidate[], opts?: { embedder?: Embedder }): Promise<Map<string, Decision>>;
  record(entry: Omit<DismissedEntry, "at" | "signal"> & { signal?: DismissedEntry["signal"]; at?: string }): Promise<void>;
  list(): Promise<DismissedEntry[]>;
}

// Tunables: semantic suppression is intentionally conservative — over-suppressing
// a real new bug is worse than one extra nit.
const SAME_RULE_THRESHOLD = 0.82;
const CROSS_RULE_THRESHOLD = 0.93;

/**
 * Security findings (secrets, injection/eval sinks) are exempt from the semantic
 * tier — they may only be silenced by an EXACT fingerprint dismissal or an
 * intentional rule `mute`, never by lexical similarity.
 *
 * Why this matters: the engine templates a finding's message on its rule alone
 * (e.g. every `secret.aws-access-key-id` carries the identical "AWS Access Key ID
 * detected on an added line…" text, independent of the matched value/file). So
 * two distinct secret findings embed to cosine ~1.0. Without this gate, a single
 * `dismiss` of a TEST FIXTURE would semantically suppress a REAL, newly-committed
 * secret of the same class anywhere in the repo — silently disabling the detector.
 * For a security control, exact-or-explicit is the only safe generalization.
 */
function semanticEligible(ruleId: string): boolean {
  return !/^(secret|security)\./.test(ruleId);
}

function decide(
  candidate: Candidate,
  fpSet: Set<string>,
  ruleSet: Set<string>,
  semantic: Array<{ rule_id: string; vec: number[] }>,
  embedder?: Embedder,
): Decision {
  if (fpSet.has(candidate.fingerprint)) {
    return { suppress: true, kind: "exact", reason: "previously dismissed (exact match)" };
  }
  if (ruleSet.has(candidate.rule_id)) {
    return { suppress: true, kind: "rule", reason: `rule '${candidate.rule_id}' is muted for this repo` };
  }
  if (semanticEligible(candidate.rule_id) && embedder && semantic.length > 0) {
    const vec = embedder.embed(candidate.text);
    let best = 0;
    let bestSameRule = 0;
    for (const e of semantic) {
      const sim = cosine(vec, e.vec);
      if (sim > best) best = sim;
      if (e.rule_id === candidate.rule_id && sim > bestSameRule) bestSameRule = sim;
    }
    if (bestSameRule >= SAME_RULE_THRESHOLD || best >= CROSS_RULE_THRESHOLD) {
      return {
        suppress: true,
        kind: "semantic",
        similarity: best,
        reason: `similar to a previously dismissed finding (${Math.round(best * 100)}%)`,
      };
    }
  }
  return { suppress: false, reason: "" };
}

function buildIndexes(entries: DismissedEntry[], embedder?: Embedder) {
  const fpSet = new Set<string>();
  const ruleSet = new Set<string>();
  const semantic: Array<{ rule_id: string; vec: number[] }> = [];
  for (const e of entries) {
    if (e.scope === "rule") ruleSet.add(e.rule_id);
    else fpSet.add(e.fingerprint);
    // Every dismissed entry contributes to semantic matching (catches near-dups).
    if (embedder) semantic.push({ rule_id: e.rule_id, vec: embedder.embed(e.text) });
  }
  return { fpSet, ruleSet, semantic };
}

// ---------------------------------------------------------------------------
// File backend — repo-local learnings.json (CLI + single-instance app)
// ---------------------------------------------------------------------------

interface FileShape {
  version: 1;
  entries: DismissedEntry[];
}

export class FileSuppressionStore implements SuppressionStore {
  constructor(private readonly path: string) {}

  private load(): FileShape {
    if (!existsSync(this.path)) return { version: 1, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<FileShape>;
      // Guard against a structurally-valid but wrong-typed `entries` (e.g. a
      // hand-edited store where it's an object/number) — iterating that downstream
      // would throw out of the unguarded dismiss/mute/learnings CLI paths.
      return { version: 1, entries: Array.isArray(parsed?.entries) ? parsed.entries : [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private save(data: FileShape): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }

  async list(): Promise<DismissedEntry[]> {
    return this.load().entries;
  }

  async evaluate(candidates: Candidate[], opts?: { embedder?: Embedder }): Promise<Map<string, Decision>> {
    const { fpSet, ruleSet, semantic } = buildIndexes(this.load().entries, opts?.embedder);
    const out = new Map<string, Decision>();
    for (const c of candidates) out.set(c.fingerprint, decide(c, fpSet, ruleSet, semantic, opts?.embedder));
    return out;
  }

  async record(
    entry: Omit<DismissedEntry, "at" | "signal"> & { signal?: DismissedEntry["signal"]; at?: string },
  ): Promise<void> {
    const data = this.load();
    const full: DismissedEntry = {
      fingerprint: entry.fingerprint,
      rule_id: entry.rule_id,
      text: entry.text,
      scope: entry.scope,
      signal: entry.signal ?? "dismissed",
      at: entry.at ?? new Date().toISOString(),
    };
    // Dedupe: one entry per (scope, fingerprint|rule).
    const key = full.scope === "rule" ? `rule:${full.rule_id}` : `fp:${full.fingerprint}`;
    data.entries = data.entries.filter((e) => (e.scope === "rule" ? `rule:${e.rule_id}` : `fp:${e.fingerprint}`) !== key);
    data.entries.push(full);
    this.save(data);
  }

  /** Remove entries matching a predicate (used by the dashboard's Learnings manager). */
  async remove(pred: (e: DismissedEntry) => boolean): Promise<number> {
    const data = this.load();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => !pred(e));
    this.save(data);
    return before - data.entries.length;
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface SuppressedFinding extends Finding {
  suppressionReason: string;
  suppressionKind?: Decision["kind"];
}

export function candidateText(f: Finding): string {
  return `${f.rule_id} ${f.title} ${f.message}`;
}

/** Partition a report's findings into kept vs learned-suppressed. */
export async function applySuppression(
  report: Report,
  store: SuppressionStore,
  opts?: { embedder?: Embedder },
): Promise<{ kept: Finding[]; suppressed: SuppressedFinding[] }> {
  const embedder = opts?.embedder ?? hashEmbedder();
  const candidates: Candidate[] = report.findings.map((f) => ({
    fingerprint: f.id,
    rule_id: f.rule_id,
    text: candidateText(f),
  }));
  const decisions = await store.evaluate(candidates, { embedder });

  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of report.findings) {
    const d = decisions.get(f.id);
    if (d?.suppress) suppressed.push({ ...f, suppressionReason: d.reason, suppressionKind: d.kind });
    else kept.push(f);
  }
  return { kept, suppressed };
}
