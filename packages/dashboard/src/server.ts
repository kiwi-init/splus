/**
 * Splus dashboard server — Hono. JSON API + zero-build static SPA + the public
 * Trust Center. Reuses the real per-repo suppression store and config shapes.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedIfEmpty } from "./seed.js";
import * as store from "./stores.js";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function asset(name: string): string | null {
  try {
    return readFileSync(join(PUBLIC, name), "utf8");
  } catch {
    return null;
  }
}

const TRUST = {
  posture: [
    { key: "no-training", label: "We never train on your code", detail: "Your source is used only to produce the review you asked for. It is never used to train models — ours or any provider's.", status: "guaranteed" },
    { key: "retention", label: "Ephemeral by default", detail: "Repos are cloned into an isolated sandbox and destroyed when the review ends. No raw code is retained after indexing; learnings store only finding fingerprints + redacted text.", status: "guaranteed" },
    { key: "self-host", label: "Self-host & BYO-LLM", detail: "Run the whole stack in your VPC. Bring your own Anthropic key (or none — the deterministic engine needs no inference at all).", status: "available" },
    { key: "provider-neutral", label: "Provider-neutral", detail: "The LLM layer is pluggable. The deterministic engine, CLI, and learnings are provider-independent and work with zero inference.", status: "available" },
    { key: "soc2", label: "SOC 2 Type II", detail: "Controls implemented; Type II observation window in progress. Report available under NDA on request.", status: "in-progress" },
    { key: "rbac", label: "SSO / SAML / RBAC / audit logs", detail: "Enterprise access controls and an immutable audit trail of every review and config change.", status: "available" },
  ],
  methodology: {
    metric: "precision = comments the developer acted on ÷ comments posted",
    basis: "Independent Martian-style methodology (did the dev actually fix the flagged line?), run on our own public, reproducible harness — not a self-graded 50-PR test.",
    anchorRule: "Every comment cites a deterministic anchor (secret pattern, metric delta, graph edge, or SARIF result). Anchors give provenance, not a free pass — precision is earned in suppression + the LLM judge.",
  },
};

const app = new Hono();

seedIfEmpty(process.env.SPLUS_SEED_FORCE === "1");

app.get("/api/overview", (c) => {
  const repos = store.listRepos().map((r) => {
    const cfg = store.getConfig(r.owner, r.name);
    const m = store.getMetrics(r.owner, r.name);
    const last = m.weeks.at(-1);
    const first = m.weeks[0];
    const lp = last ? store.precision(last) : 0;
    const fp = first ? store.precision(first) : 0;
    return {
      owner: r.owner,
      name: r.name,
      installedAt: r.installedAt,
      mode: cfg.mention_only ? "mention" : cfg.auto_review ? "auto" : "off",
      llm: cfg.llm,
      precision: lp,
      precisionDelta: lp - fp,
      reviews: m.weeks.slice(-4).reduce((s, w) => s + w.posted, 0),
      sample: m.sample,
    };
  });
  return c.json({ org: repos[0]?.owner ?? "your-org", repos });
});

app.get("/api/repos/:owner/:name/config", (c) =>
  c.json(store.getConfig(c.req.param("owner"), c.req.param("name"))),
);
app.put("/api/repos/:owner/:name/config", async (c) => {
  const body = (await c.req.json()) as Partial<store.RepoConfig>;
  store.setConfig(c.req.param("owner"), c.req.param("name"), { ...store.DEFAULT_CONFIG, ...body });
  return c.json({ ok: true });
});

app.get("/api/repos/:owner/:name/metrics", (c) => {
  const m = store.getMetrics(c.req.param("owner"), c.req.param("name"));
  return c.json({
    sample: m.sample,
    weeks: m.weeks.map((w) => ({ ...w, precision: store.precision(w), fpRate: store.fpRate(w) })),
  });
});

app.get("/api/repos/:owner/:name/learnings", async (c) =>
  c.json(await store.learningsStore(c.req.param("owner"), c.req.param("name")).list()),
);
app.delete("/api/repos/:owner/:name/learnings", async (c) => {
  const scope = c.req.query("scope");
  const key = c.req.query("key") ?? "";
  const s = store.learningsStore(c.req.param("owner"), c.req.param("name"));
  const removed = await s.remove((e) =>
    scope === "rule" ? e.scope === "rule" && e.rule_id === key : e.scope === "fingerprint" && e.fingerprint === key,
  );
  return c.json({ removed });
});

app.get("/api/billing", (c) => {
  const b = store.getBilling();
  const billed = b.authors.filter((a) => a.reviews > 0);
  return c.json({
    ...b,
    billedAuthors: billed.length,
    monthly: billed.length * b.pricePerAuthor,
    totalReviews: b.authors.reduce((s, a) => s + a.reviews, 0),
  });
});

app.get("/api/trust", (c) => c.json(TRUST));

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/trust": ["trust.html", "text/html; charset=utf-8"],
};
for (const [path, [file, type]] of Object.entries(STATIC)) {
  app.get(path, (c) => {
    const a = asset(file);
    return a ? c.body(a, 200, { "content-type": type }) : c.notFound();
  });
}

const port = Number(process.env.PORT ?? 4040);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\n  Splus dashboard  →  http://localhost:${info.port}`);
  console.log(`  Trust Center     →  http://localhost:${info.port}/trust\n`);
});
