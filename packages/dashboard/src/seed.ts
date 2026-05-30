/**
 * Seed clearly-labeled SAMPLE data so a freshly-started dashboard is populated.
 * Honesty matters (it's the whole brand): every seeded metric is flagged
 * `sample: true` and the UI badges it as illustrative. Real data replaces it as
 * the App posts reviews and records outcomes.
 */
import {
  listRepos,
  setBilling,
  setConfig,
  setMetrics,
  upsertRepo,
  type Week,
} from "./stores.js";
import { learningsStore } from "./stores.js";

const BASE = new Date("2026-03-21T00:00:00Z").getTime();
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A rising-precision / falling-FP curve over `n` weeks. */
function curve(n: number, startPrec: number, endPrec: number, basePosted: number): Week[] {
  const weeks: Week[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    // ease-out so it climbs fast then settles — looks like a real flywheel.
    const prec = startPrec + (endPrec - startPrec) * (1 - Math.pow(1 - t, 2));
    const posted = Math.round(basePosted + i * 1.5);
    const dismissed = Math.round(posted * (1 - prec));
    const addressed = posted - dismissed;
    weeks.push({
      weekStart: new Date(BASE + i * WEEK_MS).toISOString().slice(0, 10),
      posted,
      addressed,
      dismissed,
    });
  }
  return weeks;
}

export function seedIfEmpty(force = false): boolean {
  if (!force && listRepos().length > 0) return false;

  const repos = [
    { owner: "ojowwalker77", name: "Splus", llm: true, start: 0.62, end: 0.94, base: 22 },
    { owner: "ojowwalker77", name: "Claude-Matrix", llm: false, start: 0.58, end: 0.9, base: 31 },
    { owner: "acme", name: "payments-api", llm: true, start: 0.49, end: 0.86, base: 44 },
  ];

  for (const r of repos) {
    upsertRepo({ owner: r.owner, name: r.name, installedAt: "2026-03-21" });
    setConfig(r.owner, r.name, {
      auto_review: true,
      mention_only: false,
      show_nits: false,
      fail_on: r.name === "payments-api" ? "high" : "off",
      llm: r.llm,
      thorough: false,
      ignore_paths: r.name === "Claude-Matrix" ? ["dist/", "bun.lock"] : [],
    });
    setMetrics(r.owner, r.name, { sample: true, weeks: curve(11, r.start, r.end, r.base) });
  }

  // A couple of real learnings on the flagship repo (drives the Learnings screen).
  const store = learningsStore("ojowwalker77", "Splus");
  void store.record({ fingerprint: "", rule_id: "hygiene.python-print", text: "hygiene.python-print", scope: "rule", signal: "muted", at: "2026-04-04T10:00:00Z" });
  void store.record({ fingerprint: "f2b327a30c64d474", rule_id: "correctness.focused-test", text: "correctness.focused-test Focused test A focused test (.only/fdescribe/fit) was added", scope: "fingerprint", signal: "dismissed", at: "2026-04-11T14:30:00Z" });

  setBilling({
    plan: "Team",
    pricePerAuthor: 24,
    includedReviewsPerAuthor: 200,
    authors: [
      { login: "ojowwalker77", reviews: 137 },
      { login: "dependabot[bot]", reviews: 0 },
      { login: "alice-eng", reviews: 88 },
      { login: "marco-dev", reviews: 51 },
    ],
  });

  return true;
}
