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
  if (embedder && semantic.length > 0) {
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
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
      return { version: 1, entries: parsed.entries ?? [] };
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
}

// ---------------------------------------------------------------------------
// Postgres + pgvector backend — the hosted, multi-tenant production store.
// Injectable query fn so we don't hard-depend on `pg`. Schema (run once):
//
//   CREATE EXTENSION IF NOT EXISTS vector;
//   CREATE TABLE splus_dismissals (
//     id           bigserial PRIMARY KEY,
//     repo         text NOT NULL,
//     fingerprint  text NOT NULL,
//     rule_id      text NOT NULL,
//     scope        text NOT NULL,         -- 'fingerprint' | 'rule'
//     text         text NOT NULL,
//     signal       text NOT NULL,
//     embedding    vector(256),           -- hash embedder dim
//     at           timestamptz NOT NULL DEFAULT now(),
//     UNIQUE (repo, scope, fingerprint, rule_id)
//   );
//   CREATE INDEX ON splus_dismissals USING hnsw (embedding vector_cosine_ops);
//   CREATE INDEX ON splus_dismissals (repo, rule_id);
// ---------------------------------------------------------------------------

export interface PgQuery {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export class PgVectorSuppressionStore implements SuppressionStore {
  constructor(
    private readonly db: PgQuery,
    private readonly repo: string,
    private readonly embedder: Embedder = hashEmbedder(),
  ) {}

  async list(): Promise<DismissedEntry[]> {
    const { rows } = await this.db.query(
      "SELECT fingerprint, rule_id, text, signal, scope, at FROM splus_dismissals WHERE repo = $1 ORDER BY at DESC",
      [this.repo],
    );
    return rows.map((r) => ({
      fingerprint: String(r.fingerprint),
      rule_id: String(r.rule_id),
      text: String(r.text),
      signal: r.signal as DismissedEntry["signal"],
      scope: r.scope as DismissedEntry["scope"],
      at: String(r.at),
    }));
  }

  async evaluate(candidates: Candidate[], opts?: { embedder?: Embedder }): Promise<Map<string, Decision>> {
    // Exact + rule tiers in one query; semantic via per-candidate ANN.
    const entries = await this.list();
    const embedder = opts?.embedder ?? this.embedder;
    const { fpSet, ruleSet } = buildIndexes(entries, undefined);
    const out = new Map<string, Decision>();
    for (const c of candidates) {
      if (fpSet.has(c.fingerprint)) {
        out.set(c.fingerprint, { suppress: true, kind: "exact", reason: "previously dismissed (exact match)" });
        continue;
      }
      if (ruleSet.has(c.rule_id)) {
        out.set(c.fingerprint, { suppress: true, kind: "rule", reason: `rule '${c.rule_id}' is muted for this repo` });
        continue;
      }
      const vec = `[${embedder.embed(c.text).join(",")}]`;
      const { rows } = await this.db.query(
        `SELECT rule_id, 1 - (embedding <=> $2::vector) AS sim
           FROM splus_dismissals
          WHERE repo = $1 AND embedding IS NOT NULL
          ORDER BY embedding <=> $2::vector
          LIMIT 5`,
        [this.repo, vec],
      );
      let best = 0;
      let bestSameRule = 0;
      for (const r of rows) {
        const sim = Number(r.sim);
        if (sim > best) best = sim;
        if (String(r.rule_id) === c.rule_id && sim > bestSameRule) bestSameRule = sim;
      }
      out.set(
        c.fingerprint,
        bestSameRule >= SAME_RULE_THRESHOLD || best >= CROSS_RULE_THRESHOLD
          ? { suppress: true, kind: "semantic", similarity: best, reason: `similar to a previously dismissed finding (${Math.round(best * 100)}%)` }
          : { suppress: false, reason: "" },
      );
    }
    return out;
  }

  async record(
    entry: Omit<DismissedEntry, "at" | "signal"> & { signal?: DismissedEntry["signal"]; at?: string },
  ): Promise<void> {
    const vec = `[${this.embedder.embed(entry.text).join(",")}]`;
    await this.db.query(
      `INSERT INTO splus_dismissals (repo, fingerprint, rule_id, scope, text, signal, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
       ON CONFLICT (repo, scope, fingerprint, rule_id)
       DO UPDATE SET text = EXCLUDED.text, signal = EXCLUDED.signal, embedding = EXCLUDED.embedding, at = now()`,
      [this.repo, entry.fingerprint, entry.rule_id, entry.scope, entry.text, entry.signal ?? "dismissed", vec],
    );
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
