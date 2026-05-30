/**
 * Dashboard persistence. File-backed for a runnable single-instance demo;
 * the same shapes map onto the hosted Postgres/pgvector store. The learnings
 * store is the EXACT file the GitHub App and CLI write — one source of truth.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileSuppressionStore, type DismissedEntry } from "@splus/suppression";

export function dataDir(): string {
  return process.env.SPLUS_DATA_DIR ?? join(process.cwd(), ".splus-data");
}

function sanitize(s: string): string {
  return s.replace(/[^\w.@-]/g, "_");
}
function repoBase(owner: string, name: string): string {
  return join(dataDir(), `${sanitize(owner)}__${sanitize(name)}`);
}
function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(path: string, data: unknown): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// --- registry ---
export interface RepoRef {
  owner: string;
  name: string;
  installedAt: string;
}
const registryPath = () => join(dataDir(), "repos.json");
export function listRepos(): RepoRef[] {
  return readJson<RepoRef[]>(registryPath(), []);
}
export function upsertRepo(ref: RepoRef): void {
  const repos = listRepos().filter((r) => !(r.owner === ref.owner && r.name === ref.name));
  repos.push(ref);
  writeJson(registryPath(), repos);
}

// --- config (mirrors the App's .splus.yml SplusConfig) ---
export interface RepoConfig {
  auto_review: boolean;
  mention_only: boolean;
  show_nits: boolean;
  fail_on: "off" | "low" | "medium" | "high" | "critical";
  llm: boolean;
  thorough: boolean;
  ignore_paths: string[];
}
export const DEFAULT_CONFIG: RepoConfig = {
  auto_review: true,
  mention_only: false,
  show_nits: false,
  fail_on: "off",
  llm: false,
  thorough: false,
  ignore_paths: [],
};
export function getConfig(owner: string, name: string): RepoConfig {
  return { ...DEFAULT_CONFIG, ...readJson<Partial<RepoConfig>>(repoBase(owner, name) + ".config.json", {}) };
}
export function setConfig(owner: string, name: string, cfg: RepoConfig): void {
  writeJson(repoBase(owner, name) + ".config.json", cfg);
}

// --- metrics (precision / noise-floor over time) ---
export interface Week {
  weekStart: string; // YYYY-MM-DD
  posted: number;
  addressed: number;
  dismissed: number;
}
export interface Metrics {
  sample: boolean;
  weeks: Week[];
}
export function getMetrics(owner: string, name: string): Metrics {
  return readJson<Metrics>(repoBase(owner, name) + ".metrics.json", { sample: false, weeks: [] });
}
export function setMetrics(owner: string, name: string, m: Metrics): void {
  writeJson(repoBase(owner, name) + ".metrics.json", m);
}

/** precision = comments the developer acted on / comments posted (Martian methodology). */
export function precision(w: Week): number {
  return w.posted > 0 ? w.addressed / w.posted : 0;
}
/** the headline "false-positive rate": dismissed / posted. */
export function fpRate(w: Week): number {
  return w.posted > 0 ? w.dismissed / w.posted : 0;
}

// --- learnings (the real suppression store) ---
export function learningsStore(owner: string, name: string): FileSuppressionStore {
  return new FileSuppressionStore(repoBase(owner, name) + ".json");
}
export type { DismissedEntry };

// --- billing ---
export interface Billing {
  plan: string;
  pricePerAuthor: number;
  includedReviewsPerAuthor: number;
  authors: Array<{ login: string; reviews: number }>;
}
const billingPath = () => join(dataDir(), "billing.json");
export function getBilling(): Billing {
  return readJson<Billing>(billingPath(), {
    plan: "Team",
    pricePerAuthor: 24,
    includedReviewsPerAuthor: 200,
    authors: [],
  });
}
export function setBilling(b: Billing): void {
  writeJson(billingPath(), b);
}
