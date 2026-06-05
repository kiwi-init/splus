import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMemoryStore } from "./memory.js";

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "splus-mem-")), "memory.json");
}

test("remembers and recalls the most relevant memory first", async () => {
  const store = new FileMemoryStore(storePath());
  await store.remember({ kind: "accepted", text: "double-charge on retry of settleInvoice without idempotency key" });
  await store.remember({ kind: "note", text: "we use Result<T,E>, never throw in the billing module" });

  const hits = await store.recall("retry settleInvoice idempotency double charge");
  assert.ok(hits.length >= 1);
  assert.match(hits[0]!.text, /double-charge/);
  assert.ok(hits[0]!.score > hits[hits.length - 1]!.score || hits.length === 1);
});

test("dedupes near-identical memories of the same kind", async () => {
  const store = new FileMemoryStore(storePath());
  const a = await store.remember({ kind: "note", text: "tests may use any; fixtures are not reviewed" });
  const b = await store.remember({ kind: "note", text: "tests may use any; fixtures are not reviewed" });
  assert.equal(a.id, b.id);
});

test("recall on an empty store returns nothing, never throws", async () => {
  const store = new FileMemoryStore(storePath());
  assert.deepEqual(await store.recall("anything"), []);
});
