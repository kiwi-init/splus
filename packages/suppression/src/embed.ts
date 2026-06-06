/**
 * Dependency-free feature-hash embedder. Deterministic, no model download, no
 * API key — captures lexical similarity (same rule + similar message/code),
 * which is exactly what catches near-duplicate findings. A richer transformers
 * embedder can be swapped in later behind the same `Embedder` interface.
 */

export interface Embedder {
  name: string;
  dim: number;
  embed(text: string): number[];
}

/** Default embedder: signed feature hashing of word + 3-gram tokens, L2-normalized. */
export function hashEmbedder(dim = 256): Embedder {
  return { name: `hash-${dim}`, dim, embed: (t) => featureHash(t, dim) };
}

function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_.:/-]+/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    out.push("w:" + w);
    for (let i = 0; i + 3 <= w.length; i++) out.push("g:" + w.slice(i, i + 3));
  }
  return out;
}

function featureHash(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of tokens(text)) {
    const h = fnv1a(tok);
    const idx = (h >>> 1) % dim;
    const sign = h & 1 ? 1 : -1;
    v[idx]! += sign;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

/** Cosine similarity of two L2-normalized vectors (== dot product). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
