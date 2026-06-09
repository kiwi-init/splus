import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditBlock,
  extendFloor,
  ledgerFor,
  parseChangedSymbols,
  recordInspect,
  recordResolution,
  startLedger,
} from "./audit.js";

// Each test uses a distinct fake repo root — the ledger map is module-global.
let n = 0;
function repo(): string {
  return `/fake/repo-${n++}`;
}

test("parses changedExportedSymbols lines into (file, symbol) pairs", () => {
  const pairs = parseChangedSymbols(["src/a.ts: foo, bar", "src/b.ts: baz", "garbage-line"]);
  assert.deepEqual(pairs, [
    { file: "src/a.ts", symbol: "foo" },
    { file: "src/a.ts", symbol: "bar" },
    { file: "src/b.ts", symbol: "baz" },
  ]);
});

test("audit without a review ledger says to call review first", () => {
  assert.match(auditBlock("/never/reviewed"), /call `review` first/);
});

test("audit flags untraced exports and unaccounted floor findings", () => {
  const r = repo();
  startLedger(r, ["fp1", "fp2", "fp3"], ["src/a.ts: foo, bar"]);
  recordInspect(r, "callers", "foo"); // foo traced; bar never inspected
  recordInspect(r, "definition", "bar"); // definition is not a contract trace
  recordResolution(r, "fp1", "dismissed");

  const block = auditBlock(r, ["fp2"]); // fp3 left unaccounted
  assert.match(block, /Contract traces: 1\/2/);
  assert.match(block, /never inspected: bar \(src\/a\.ts\)/);
  assert.match(block, /1 kept · 1 dismissed · 0 accepted · 1 unaccounted/);
  assert.match(block, /unaccounted floor finding: fp3/);
  assert.match(block, /AUDIT INCOMPLETE/);
});

test("audit is clean when every export is traced and every finding has a fate", () => {
  const r = repo();
  startLedger(r, ["fp1", "fp2"], ["src/a.ts: foo"]);
  recordInspect(r, "blast_radius", "foo");
  recordResolution(r, "fp1", "accepted");

  const block = auditBlock(r, ["fp2"]);
  assert.match(block, /Contract traces: 1\/1/);
  assert.match(block, /0 unaccounted/);
  assert.match(block, /AUDIT CLEAN/);
});

test("without keptIds the audit asks for them instead of certifying", () => {
  const r = repo();
  startLedger(r, ["fp1"], []);
  const block = auditBlock(r);
  assert.match(block, /kept not declared/);
  assert.match(block, /Pass `keptIds`/);
});

test("floor re-grounding extends the accountable floor; review resets it", () => {
  const r = repo();
  startLedger(r, ["fp1"], []);
  extendFloor(r, ["fp9"]);
  assert.match(auditBlock(r, ["fp1"]), /unaccounted floor finding: fp9/);

  // A fresh `review` starts a fresh ledger.
  startLedger(r, ["fp1"], []);
  assert.equal(ledgerFor(r)?.floorIds.size, 1);
  assert.match(auditBlock(r, ["fp1"]), /AUDIT CLEAN/);
});
