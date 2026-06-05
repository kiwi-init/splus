/**
 * Compounding review memory — the other half of learning.
 *
 * Where the suppression store teaches Splus what to STOP flagging, the memory
 * store remembers what mattered: confirmed-real findings (`accept`) and
 * conventions the reviewer discovered (`note`). `recall` then surfaces them for a
 * new hunk, so a reviewer's diligence persists across sessions instead of
 * evaporating. Embedding-based via the shared `Embedder` seam (the deterministic,
 * offline `hashEmbedder` by default; a transformer model drops in unchanged).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cosine, hashEmbedder, type Embedder } from "./embed.js";

export type MemoryKind = "note" | "accepted";

export interface Memory {
  id: string;
  kind: MemoryKind;
  text: string;
  scope: "repo" | "user";
  file?: string;
  ts: string;
  embedding: number[];
}

export interface RecallHit {
  id: string;
  kind: MemoryKind;
  text: string;
  file?: string;
  /** Cosine similarity to the query (0..1). */
  score: number;
}

export interface RememberInput {
  kind: MemoryKind;
  text: string;
  scope?: "repo" | "user";
  file?: string;
}

/** Two memories of the same kind closer than this are treated as duplicates. */
const DUP_THRESHOLD = 0.97;

/** A repo-local memory store (one JSON file per repo). */
export class FileMemoryStore {
  constructor(
    private readonly path: string,
    private readonly embedder: Embedder = hashEmbedder(),
  ) {}

  private async load(): Promise<Memory[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      return Array.isArray(parsed) ? (parsed as Memory[]) : [];
    } catch {
      return [];
    }
  }

  private async save(memories: Memory[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(memories, null, 2));
  }

  /** Persist a memory; returns an existing near-duplicate instead of duplicating. */
  async remember(input: RememberInput): Promise<Memory> {
    const memories = await this.load();
    const embedding = this.embedder.embed(input.text);
    const dup = memories.find(
      (m) => m.kind === input.kind && cosine(m.embedding, embedding) >= DUP_THRESHOLD,
    );
    if (dup) return dup;

    const memory: Memory = {
      id: "m_" + hash(input.kind + "\0" + input.text),
      kind: input.kind,
      text: input.text,
      scope: input.scope ?? "repo",
      file: input.file,
      ts: new Date().toISOString(),
      embedding,
    };
    memories.push(memory);
    await this.save(memories);
    return memory;
  }

  /** The memories most semantically similar to `query`, best first. */
  async recall(query: string, opts: { limit?: number; minScore?: number } = {}): Promise<RecallHit[]> {
    const memories = await this.load();
    const q = this.embedder.embed(query);
    return memories
      .map((m) => ({ m, score: cosine(m.embedding, q) }))
      .filter((x) => x.score >= (opts.minScore ?? 0.2))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 5)
      .map((x) => ({ id: x.m.id, kind: x.m.kind, text: x.m.text, file: x.m.file, score: round(x.score) }));
  }
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
