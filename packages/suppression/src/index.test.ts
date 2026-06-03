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

const AWS_MSG =
  "AWS Access Key ID detected on an added line. Remove the secret, rotate it, and load it from a secret manager or environment variable.";

test("secret rules are exempt from semantic suppression: a dismissed fixture must NOT hide a real secret", async () => {
  const store = newStore();
  // A test fixture (e.g. the engine's own detector test) was dismissed by fingerprint.
  const fixture = f("akia-fixture", "secret.aws-access-key-id", "AWS Access Key ID", AWS_MSG);
  await store.record({
    fingerprint: fixture.id,
    rule_id: fixture.rule_id,
    text: candidateText(fixture),
    scope: "fingerprint",
    at: "2026-06-02T00:00:00Z",
  });

  // A REAL secret of the same class: byte-identical templated message (cosine ~1.0)
  // but a DIFFERENT fingerprint (different key value). It must survive.
  const real = f("akia-real", "secret.aws-access-key-id", "AWS Access Key ID", AWS_MSG);
  const out = await applySuppression(report([real]), store);

  assert.equal(out.suppressed.length, 0, "a fixture dismissal must not semantically suppress a real secret");
  assert.ok(out.kept.some((k) => k.id === "akia-real"), "the real secret must be kept");
});

test("accepted findings reinforce similar future findings (positive memory)", async () => {
  const store = newStore();
  // A reviewer confirmed a real SSRF finding on a past PR.
  const accepted = f("ssrf-1", "security.ssrf", "Server-side request forgery",
    "A user-controlled URL is fetched server-side without host allow-listing — an SSRF sink.");
  await store.record({
    fingerprint: accepted.id, rule_id: accepted.rule_id, text: candidateText(accepted),
    scope: "fingerprint", signal: "accepted", at: "2026-06-02T00:00:00Z",
  });

  // A new, near-identical finding on this PR (different fingerprint) must be KEPT
  // and flagged as reinforced; an unrelated nit must not be.
  const similar = f("ssrf-2", "security.ssrf", "Server-side request forgery",
    "A user-controlled URL is fetched server-side without host allow-listing — an SSRF sink.");
  const unrelated = f("nit-1", "hygiene.python-print", "Debug print", "A print( was added.");

  const out = await applySuppression(report([similar, unrelated]), store);
  assert.equal(out.suppressed.length, 0, "positive memory never suppresses");
  assert.ok(out.kept.some((k) => k.id === "ssrf-2"));
  assert.ok(out.reinforced.some((r) => r.id === "ssrf-2"), "similar finding should be reinforced");
  assert.ok(!out.reinforced.some((r) => r.id === "nit-1"), "unrelated nit should not be reinforced");
});

test("muting a secret rule still silences it (explicit opt-in remains possible)", async () => {
  const store = newStore();
  await store.record({
    fingerprint: "",
    rule_id: "secret.aws-access-key-id",
    text: "secret.aws-access-key-id",
    scope: "rule",
    at: "2026-06-02T00:00:00Z",
  });
  const real = f("akia-real", "secret.aws-access-key-id", "AWS Access Key ID", AWS_MSG);
  const out = await applySuppression(report([real]), store);

  assert.equal(out.suppressed.length, 1, "an explicit rule mute still suppresses");
  assert.equal(out.suppressed[0]?.suppressionKind, "rule");
});
