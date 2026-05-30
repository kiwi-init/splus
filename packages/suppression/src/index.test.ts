import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding, Report } from "@splus/shared";
import { applySuppression, candidateText, FileSuppressionStore } from "./index.js";

function f(id: string, ruleId: string, title: string, message: string): Finding {
  return {
    id,
    rule_id: ruleId,
    category: "hygiene",
    severity: "low",
    tier: "nit",
    confidence: 0.9,
    file: "src/a.ts",
    region: { start_line: 1, start_col: 0, end_line: 1, end_col: 0 },
    title,
    message,
    anchor: { kind: "heuristic", detail: "x" },
    introduced: true,
    source: "heuristics",
  };
}

function report(findings: Finding[]): Report {
  return {
    tool: "splus",
    version: "0.1.0",
    summary: {
      files_changed: 1,
      added_lines: 1,
      findings_total: findings.length,
      must_fix: 0,
      concern: 0,
      nit: findings.length,
      suppressed: 0,
      collectors_run: [],
      adapters_absent: [],
      notes: [],
    },
    findings,
  };
}

function newStore(): FileSuppressionStore {
  const dir = mkdtempSync(join(tmpdir(), "splus-supp-"));
  return new FileSuppressionStore(join(dir, "learnings.json"));
}

test("exact fingerprint dismissal suppresses that finding", async () => {
  const store = newStore();
  const a = f("fp1", "hygiene.debug-console", "Debug console statement", "console.log added");
  await store.record({ fingerprint: a.id, rule_id: a.rule_id, text: candidateText(a), scope: "fingerprint", at: "2026-05-30T00:00:00Z" });

  const out = await applySuppression(report([a, f("fp2", "security.x", "Other", "unrelated thing")]), store);
  assert.equal(out.suppressed.length, 1);
  assert.equal(out.suppressed[0]?.id, "fp1");
  assert.equal(out.suppressed[0]?.suppressionKind, "exact");
  assert.equal(out.kept.length, 1);
});

test("rule mute suppresses all findings of that rule", async () => {
  const store = newStore();
  await store.record({ fingerprint: "", rule_id: "hygiene.python-print", text: "hygiene.python-print", scope: "rule", at: "2026-05-30T00:00:00Z" });

  const out = await applySuppression(
    report([
      f("p1", "hygiene.python-print", "Debug print", "print added in a.py"),
      f("p2", "hygiene.python-print", "Debug print", "print added in b.py"),
      f("k1", "security.x", "Keep", "real issue"),
    ]),
    store,
  );
  assert.equal(out.suppressed.length, 2);
  assert.ok(out.suppressed.every((s) => s.suppressionKind === "rule"));
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0]?.id, "k1");
});

test("semantic suppression catches near-duplicates, keeps unrelated", async () => {
  const store = newStore();
  const dismissed = f("d1", "hygiene.debug-console", "Debug console statement", "A console debug statement was added. Remove it or use a structured logger.");
  await store.record({ fingerprint: dismissed.id, rule_id: dismissed.rule_id, text: candidateText(dismissed), scope: "fingerprint", at: "2026-05-30T00:00:00Z" });

  // Same rule, near-identical message but DIFFERENT fingerprint → semantic match.
  const nearDup = f("d2", "hygiene.debug-console", "Debug console statement", "A console debug statement was added. Remove it or use a structured logger.");
  const unrelated = f("u1", "security.sqli", "SQL Injection", "User input flows into a SQL query without parameterization.");

  const out = await applySuppression(report([nearDup, unrelated]), store);
  const suppressedIds = out.suppressed.map((s) => s.id);
  assert.ok(suppressedIds.includes("d2"), "near-duplicate should be suppressed");
  assert.equal(out.suppressed.find((s) => s.id === "d2")?.suppressionKind, "semantic");
  assert.ok(out.kept.some((k) => k.id === "u1"), "unrelated finding should be kept");
});
