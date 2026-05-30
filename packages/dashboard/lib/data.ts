/**
 * Sample data for the S+ dashboard. Everything here is clearly-labeled SAMPLE
 * (honesty is the brand) — real numbers replace it once the GitHub App posts
 * reviews and a Postgres/pgvector store is wired behind these same shapes.
 */

export interface Week {
  weekStart: string;
  precision: number; // acted-on ÷ posted
  fpRate: number; // dismissed ÷ posted  (= 1 - precision)
}

export interface RepoConfig {
  auto_review: boolean;
  mention_only: boolean;
  llm: boolean;
  thorough: boolean;
  show_nits: boolean;
  fail_on: "off" | "low" | "medium" | "high" | "critical";
  ignore_paths: string[];
}

export interface Learning {
  scope: "rule" | "fingerprint";
  rule_id: string;
  fingerprint: string;
  signal: string;
  at: string;
}

export interface RepoData {
  owner: string;
  name: string;
  sample: boolean;
  reviews: number; // last 4 weeks
  config: RepoConfig;
  weeks: Week[];
  learnings: Learning[];
}

export interface Author {
  login: string;
  reviews: number;
}

const BASE = Date.parse("2026-03-21T00:00:00Z");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A rising-precision / falling-FP curve over `n` weeks (ease-out flywheel). */
function curve(n: number, startPrec: number, endPrec: number, basePosted: number): { weeks: Week[]; reviews4wk: number } {
  const weeks: Week[] = [];
  let postedLast4 = 0;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    const precision = startPrec + (endPrec - startPrec) * (1 - Math.pow(1 - t, 2));
    const posted = Math.round(basePosted + i * 1.5);
    if (i >= n - 4) postedLast4 += posted;
    weeks.push({
      weekStart: new Date(BASE + i * WEEK_MS).toISOString().slice(0, 10),
      precision: Math.round(precision * 1000) / 1000,
      fpRate: Math.round((1 - precision) * 1000) / 1000,
    });
  }
  return { weeks, reviews4wk: postedLast4 };
}

interface RepoSeed {
  owner: string;
  name: string;
  llm: boolean;
  start: number;
  end: number;
  base: number;
  fail_on: RepoConfig["fail_on"];
  ignore_paths: string[];
  learnings: Learning[];
}

const SEED: RepoSeed[] = [
  {
    owner: "ojowwalker77",
    name: "Splus",
    llm: true,
    start: 0.62,
    end: 0.94,
    base: 22,
    fail_on: "off",
    ignore_paths: [],
    learnings: [
      { scope: "rule", rule_id: "hygiene.python-print", fingerprint: "", signal: "muted", at: "2026-04-04T10:00:00Z" },
      {
        scope: "fingerprint",
        rule_id: "correctness.focused-test",
        fingerprint: "f2b327a30c64d474",
        signal: "dismissed",
        at: "2026-04-11T14:30:00Z",
      },
    ],
  },
  { owner: "ojowwalker77", name: "Claude-Matrix", llm: false, start: 0.58, end: 0.9, base: 31, fail_on: "off", ignore_paths: ["dist/", "bun.lock"], learnings: [] },
  { owner: "acme", name: "payments-api", llm: true, start: 0.49, end: 0.86, base: 44, fail_on: "high", ignore_paths: [], learnings: [] },
];

const REPOS: RepoData[] = SEED.map((s) => {
  const { weeks, reviews4wk } = curve(11, s.start, s.end, s.base);
  return {
    owner: s.owner,
    name: s.name,
    sample: true,
    reviews: reviews4wk,
    config: {
      auto_review: true,
      mention_only: false,
      llm: s.llm,
      thorough: false,
      show_nits: false,
      fail_on: s.fail_on,
      ignore_paths: s.ignore_paths,
    },
    weeks,
    learnings: s.learnings,
  };
});

export const ORG = "ojowwalker77";

export function listRepos(): RepoData[] {
  return REPOS;
}

export function getRepo(owner: string, name: string): RepoData | undefined {
  return REPOS.find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase());
}

export function repoMode(c: RepoConfig): "auto" | "mention" | "off" {
  if (c.mention_only) return "mention";
  if (c.auto_review) return "auto";
  return "off";
}

export function repoPrecision(r: RepoData): { precision: number; delta: number } {
  const last = r.weeks[r.weeks.length - 1];
  const first = r.weeks[0];
  return { precision: last?.precision ?? 0, delta: (last?.precision ?? 0) - (first?.precision ?? 0) };
}

export const BILLING = {
  plan: "Team",
  pricePerAuthor: 24,
  includedReviewsPerAuthor: 200,
  authors: [
    { login: "ojowwalker77", reviews: 137 },
    { login: "dependabot[bot]", reviews: 0 },
    { login: "alice-eng", reviews: 88 },
    { login: "marco-dev", reviews: 51 },
  ] as Author[],
};

export function billingSummary() {
  const billed = BILLING.authors.filter((a) => a.reviews > 0);
  const monthly = billed.length * BILLING.pricePerAuthor;
  const totalReviews = BILLING.authors.reduce((s, a) => s + a.reviews, 0);
  return { ...BILLING, billedAuthors: billed.length, monthly, totalReviews };
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;
