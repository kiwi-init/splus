import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSplusConfig, applyPolicy, matchGlob, type SplusConfig } from "./splusMd.js";
import type { Finding } from "./index.js";

function tmpRepo(splusMd?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "splus-md-"));
  if (splusMd !== undefined) writeFileSync(join(dir, "splus.md"), splusMd);
  return dir;
}

function finding(over: Partial<Finding>): Finding {
  return {
    id: "f1",
    rule_id: "hygiene.console-log",
    category: "hygiene",
    severity: "low",
    tier: "nit",
    confidence: 0.8,
    file: "src/api/users.ts",
    region: { start_line: 1, start_col: 0, end_line: 1, end_col: 0 },
    title: "t",
    message: "m",
    anchor: { kind: "heuristic", detail: "d" },
    introduced: true,
    source: "heuristics",
    ...over,
  };
}

test("loads repo contract and parses mute/skip directives", () => {
  const repo = tmpRepo(
    [
      "# splus.md",
      "## nits",
      "- console.log is fine in scripts.",
      "- mute: hygiene.console-log",
      "skip: generated/**",
    ].join("\n"),
  );
  // Isolate from any real ~/.splus by pointing home at the temp dir.
  const cfg = loadSplusConfig(repo, repo);
  assert.equal(cfg.source, "repo");
  assert.ok(cfg.raw.includes("console.log is fine"));
  assert.deepEqual(cfg.mutedRules, ["hygiene.console-log"]);
  assert.deepEqual(cfg.skipPaths, ["generated/**"]);
});

test("missing file yields an empty, non-throwing contract", () => {
  const repo = tmpRepo();
  const cfg = loadSplusConfig(repo, repo);
  assert.equal(cfg.source, "none");
  assert.equal(cfg.raw, "");
  assert.deepEqual(cfg.mutedRules, []);
});

test("applyPolicy drops muted rules and skip paths, keeps the rest", () => {
  const cfg: SplusConfig = {
    raw: "",
    mutedRules: ["hygiene.console-log"],
    skipPaths: ["generated/**"],
    source: "repo",
  };
  const findings = [
    finding({ id: "a", rule_id: "hygiene.console-log" }), // muted
    finding({ id: "b", rule_id: "sec.sqli", file: "generated/db.ts" }), // skipped path
    finding({ id: "c", rule_id: "sec.sqli", file: "src/api/users.ts" }), // kept
  ];
  const { kept, dropped } = applyPolicy(findings, cfg);
  assert.deepEqual(kept.map((f) => f.id), ["c"]);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((d) => d.reason));
});

test("matchGlob handles ** across separators and * within a segment", () => {
  assert.ok(matchGlob("generated/**", "generated/a/b.ts"));
  assert.ok(matchGlob("**/*.pb.go", "proto/gen/user.pb.go"));
  assert.ok(matchGlob("examples/keys.sample.env", "examples/keys.sample.env"));
  assert.ok(!matchGlob("src/*.ts", "src/a/b.ts"));
  assert.ok(matchGlob("src/*.ts", "src/a.ts"));
});
