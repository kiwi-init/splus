/**
 * @splus/suppression — the learned, per-repo memory (the compounding moat).
 *
 * Negative memory (suppress noise), cheapest first:
 *   1. exact      — the same finding (by fingerprint) was dismissed before.
 *   2. rule-mute  — the whole rule was muted for this repo.
 *   3. semantic   — cosine-similar to a dismissed finding (feature-hash embedder).
 *
 * Positive memory (reinforce signal):
 *   4. reinforce  — cosine-similar to a finding a reviewer CONFIRMED real (accepted).
 *                   Never suppresses; raises the finding's priority so the review
 *                   learns what THIS repo's reviewers actually care about.
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
  /**
   * What we learned from. Negative signals (`dismissed`/`downvoted`/`muted`)
   * suppress; `accepted` is positive memory — a finding a reviewer confirmed real.
   */
  signal: "dismissed" | "downvoted" | "muted" | "accepted";
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
  /** Positive memory: similar to a finding a reviewer confirmed real (accepted). */
  reinforce?: boolean;
  reinforcement?: number;
  /**
   * The only suppression that matched has aged out: the finding is KEPT and
   * resurfaced once for re-validation. Dismissing it again refreshes the
   * learning for another TTL window.
   */
  revalidate?: boolean;
}

export interface SuppressionStore {
  evaluate(
    candidates: Candidate[],
    opts?: { embedder?: Embedder; now?: string },
  ): Promise<Map<string, Decision>>;
  record(entry: Omit<DismissedEntry, "at" | "signal"> & { signal?: DismissedEntry["signal"]; at?: string }): Promise<void>;
  list(): Promise<DismissedEntry[]>;
}

// Tunables: semantic suppression is intentionally conservative — over-suppressing
// a real new bug is worse than one extra nit.
const SAME_RULE_THRESHOLD = 0.82;
const CROSS_RULE_THRESHOLD = 0.93;
// Reinforcement is more liberal: a false boost only nudges ranking, never hides.
const REINFORCE_THRESHOLD = 0.8;

/**
 * Suppression decay: a dismissal is a snapshot of one moment's judgment, and the
 * code around it keeps moving. Aged-out dismissals stop suppressing and the
 * finding resurfaces ONCE for re-validation (dismiss again to refresh — `record`
 * replaces the entry with a fresh timestamp). Semantic matches decay faster than
 * exact ones because generalization is where a stale judgment does real damage:
 * an old "this is a test fixture" wave-off can otherwise hide a genuinely new
 * variant forever. Rule mutes never decay — muting a rule is an explicit,
 * config-level act (and `SPLUS.md` `mute:` lines are the durable home for it).
 */
export const EXACT_TTL_DAYS = 180;
export const SEMANTIC_TTL_DAYS = 90;

function ageDays(at: string, now: string): number {
  const a = Date.parse(at);
  const n = Date.parse(now);
  // Malformed timestamps never decay (resurfacing on bad data would be noise).
  if (!Number.isFinite(a) || !Number.isFinite(n)) return 0;
  return (n - a) / 86_400_000;
}

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

interface Indexes {
  /** Dismissed fingerprint → ISO timestamp of the (latest) dismissal. */
  fpMap: Map<string, string>;
  ruleSet: Set<string>;
  semanticNeg: Array<{ rule_id: string; vec: number[]; at: string }>;
  semanticPos: Array<{ rule_id: string; vec: number[] }>;
}

function decide(candidate: Candidate, idx: Indexes, embedder?: Embedder, now?: string): Decision {
  const nowIso = now ?? new Date().toISOString();
  let stale: { kind: "exact" | "semantic"; at: string } | null = null;

  const exactAt = idx.fpMap.get(candidate.fingerprint);
  if (exactAt !== undefined) {
    if (ageDays(exactAt, nowIso) <= EXACT_TTL_DAYS) {
      return { suppress: true, kind: "exact", reason: "previously dismissed (exact match)" };
    }
    stale = { kind: "exact", at: exactAt };
  }
  // Rule mutes are explicit, config-level acts — they never decay.
  if (idx.ruleSet.has(candidate.rule_id)) {
    return { suppress: true, kind: "rule", reason: `rule '${candidate.rule_id}' is muted for this repo` };
  }
  const vec = embedder ? embedder.embed(candidate.text) : null;
  // Negative memory: suppress noise like something dismissed before. Only
  // entries inside the semantic TTL may suppress; the best aged-out match is
  // remembered so the finding resurfaces with a re-validation reason instead.
  if (vec && semanticEligible(candidate.rule_id) && idx.semanticNeg.length > 0) {
    let best = 0;
    let bestSameRule = 0;
    let staleBest = 0;
    let staleBestSameRule = 0;
    let staleAt = "";
    for (const e of idx.semanticNeg) {
      const sim = cosine(vec, e.vec);
      if (ageDays(e.at, nowIso) <= SEMANTIC_TTL_DAYS) {
        if (sim > best) best = sim;
        if (e.rule_id === candidate.rule_id && sim > bestSameRule) bestSameRule = sim;
      } else {
        if (sim > staleBest) {
          staleBest = sim;
          staleAt = e.at;
        }
        if (e.rule_id === candidate.rule_id && sim > staleBestSameRule) staleBestSameRule = sim;
      }
    }
    if (bestSameRule >= SAME_RULE_THRESHOLD || best >= CROSS_RULE_THRESHOLD) {
      return {
        suppress: true,
        kind: "semantic",
        similarity: best,
        reason: `similar to a previously dismissed finding (${Math.round(best * 100)}%)`,
      };
    }
    if (!stale && (staleBestSameRule >= SAME_RULE_THRESHOLD || staleBest >= CROSS_RULE_THRESHOLD)) {
      stale = { kind: "semantic", at: staleAt };
    }
  }
  if (stale) {
    const ttl = stale.kind === "exact" ? EXACT_TTL_DAYS : SEMANTIC_TTL_DAYS;
    return {
      suppress: false,
      revalidate: true,
      kind: stale.kind,
      reason:
        `a matching suppression aged out (dismissed ${stale.at.slice(0, 10)}, TTL ${ttl}d) — ` +
        `resurfacing once for re-validation; dismiss again if still noise`,
    };
  }
  // Positive memory: reinforce signal like something a reviewer confirmed real.
  // Not gated by `semanticEligible` — reinforcing a real security finding is safe
  // (it never suppresses, only raises priority).
  if (vec && idx.semanticPos.length > 0) {
    let best = 0;
    for (const e of idx.semanticPos) {
      const sim = cosine(vec, e.vec);
      if (sim > best) best = sim;
    }
    if (best >= REINFORCE_THRESHOLD) {
      return { suppress: false, reason: "", reinforce: true, reinforcement: best };
    }
  }
  return { suppress: false, reason: "" };
}

function buildIndexes(entries: DismissedEntry[], embedder?: Embedder): Indexes {
  const fpMap = new Map<string, string>();
  const ruleSet = new Set<string>();
  const semanticNeg: Array<{ rule_id: string; vec: number[]; at: string }> = [];
  const semanticPos: Array<{ rule_id: string; vec: number[] }> = [];
  for (const e of entries) {
    if (e.signal === "accepted") {
      // Positive memory: an accepted finding never suppresses; it reinforces.
      if (embedder) semanticPos.push({ rule_id: e.rule_id, vec: embedder.embed(e.text) });
      continue;
    }
    if (e.scope === "rule") {
      ruleSet.add(e.rule_id);
    } else {
      // Latest dismissal wins (re-dismissing refreshes the TTL).
      const prev = fpMap.get(e.fingerprint);
      if (prev === undefined || e.at > prev) fpMap.set(e.fingerprint, e.at);
    }
    // Every dismissed entry contributes to semantic matching (catches near-dups).
    if (embedder) semanticNeg.push({ rule_id: e.rule_id, vec: embedder.embed(e.text), at: e.at });
  }
  return { fpMap, ruleSet, semanticNeg, semanticPos };
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

  async evaluate(
    candidates: Candidate[],
    opts?: { embedder?: Embedder; now?: string },
  ): Promise<Map<string, Decision>> {
    const idx = buildIndexes(this.load().entries, opts?.embedder);
    const out = new Map<string, Decision>();
    for (const c of candidates) out.set(c.fingerprint, decide(c, idx, opts?.embedder, opts?.now));
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

/** A kept finding the positive memory recognized as confirmed-real-like. */
export interface ReinforcedFinding {
  id: string;
  reinforcement: number;
}

/** A kept finding whose only matching suppression aged out (resurfaced once). */
export interface RevalidationFinding {
  id: string;
  reason: string;
}

/**
 * Partition a report's findings into kept vs learned-suppressed, flag the kept
 * findings that positive memory reinforced (similar to a confirmed-real one),
 * and surface the ones that only escaped suppression because the matching
 * dismissal aged out (re-validation candidates).
 */
export async function applySuppression(
  report: Report,
  store: SuppressionStore,
  opts?: { embedder?: Embedder; now?: string },
): Promise<{
  kept: Finding[];
  suppressed: SuppressedFinding[];
  reinforced: ReinforcedFinding[];
  revalidations: RevalidationFinding[];
}> {
  const embedder = opts?.embedder ?? hashEmbedder();
  const candidates: Candidate[] = report.findings.map((f) => ({
    fingerprint: f.id,
    rule_id: f.rule_id,
    text: candidateText(f),
  }));
  const decisions = await store.evaluate(candidates, { embedder, now: opts?.now });

  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  const reinforced: ReinforcedFinding[] = [];
  const revalidations: RevalidationFinding[] = [];
  for (const f of report.findings) {
    const d = decisions.get(f.id);
    if (d?.suppress) {
      suppressed.push({ ...f, suppressionReason: d.reason, suppressionKind: d.kind });
    } else {
      kept.push(f);
      if (d?.reinforce) reinforced.push({ id: f.id, reinforcement: d.reinforcement ?? 0 });
      if (d?.revalidate) revalidations.push({ id: f.id, reason: d.reason });
    }
  }
  return { kept, suppressed, reinforced, revalidations };
}

// Compounding review memory (accept/note → recall).
export * from "./memory.js";
