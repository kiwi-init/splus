import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiffAnchorIndex,
  anchorFinding,
  reviewEvent,
  buildReviewPayload,
  commentMarker,
} from "./prReview.js";

// A small but realistic two-file unified diff: one added file region and one
// edit with surrounding context + a removed line.
const DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -10,6 +10,8 @@ export function login(req) {",
  " const u = req.user;", // 10 ctx
  " if (!u) return null;", // 11 ctx
  "-  const ok = check(u.pass);", // (removed — LEFT)
  "+  const ok = check(u.password);", // 12 add
  "+  if (!ok) return null;", // 13 add
  " return session(u);", // 14 ctx
  " }", // 15 ctx
  "@@ -40,3 +42,4 @@ function helper() {",
  " const x = 1;", // 42 ctx
  "+  const y = 2;", // 43 add
  " return x;", // 44 ctx
  " }", // 45 ctx
  "diff --git a/src/db.ts b/src/db.ts",
  "index 3333333..4444444 100644",
  "--- a/src/db.ts",
  "+++ b/src/db.ts",
  "@@ -1,2 +1,3 @@",
  "+import x from 'x';", // 1 add
  " const a = 1;", // 2 ctx
  " const b = 2;", // 3 ctx
].join("\n");

test("indexes new-side commentable lines per file (added + context, not removed)", () => {
  const idx = buildDiffAnchorIndex(DIFF);
  const auth = idx.get("src/auth.ts");
  assert.ok(auth);
  // First hunk: 10,11 ctx, 12,13 added, 14,15 ctx all commentable on the new side.
  for (const n of [10, 11, 12, 13, 14, 15]) assert.equal(auth!.commentable.has(n), true, `line ${n}`);
  // Second hunk: 42..45.
  for (const n of [42, 43, 44, 45]) assert.equal(auth!.commentable.has(n), true, `line ${n}`);
  // A removed-only old line (the old `const ok = check(u.pass)`) is not a new-side line.
  assert.equal(auth!.commentable.has(16), false);

  const db = idx.get("src/db.ts");
  assert.ok(db);
  for (const n of [1, 2, 3]) assert.equal(db!.commentable.has(n), true);
});

test("anchors a single added line on the RIGHT", () => {
  const idx = buildDiffAnchorIndex(DIFF);
  assert.deepEqual(anchorFinding(idx, "src/auth.ts", 12), {
    path: "src/auth.ts",
    side: "RIGHT",
    line: 12,
  });
});

test("multi-line anchor within one hunk sets start_line + line", () => {
  const idx = buildDiffAnchorIndex(DIFF);
  assert.deepEqual(anchorFinding(idx, "src/auth.ts", 12, 13), {
    path: "src/auth.ts",
    side: "RIGHT",
    line: 13,
    start_line: 12,
  });
});

test("range spanning two hunks collapses to a single-line comment on the end", () => {
  const idx = buildDiffAnchorIndex(DIFF);
  // 13 is in hunk 0, 43 is in hunk 1 — cross-hunk, so no start_line.
  assert.deepEqual(anchorFinding(idx, "src/auth.ts", 13, 43), {
    path: "src/auth.ts",
    side: "RIGHT",
    line: 43,
  });
});

test("falls back to the start line when only it is in the diff", () => {
  const idx = buildDiffAnchorIndex(DIFF);
  // 12 is commentable, 999 is not → anchor on 12.
  assert.deepEqual(anchorFinding(idx, "src/auth.ts", 12, 999), {
    path: "src/auth.ts",
    side: "RIGHT",
    line: 12,
  });
});

test("returns null for a file not in the diff and a line outside any hunk", () => {
  const idx = buildDiffAnchorIndex(DIFF);
  assert.equal(anchorFinding(idx, "src/missing.ts", 5), null);
  assert.equal(anchorFinding(idx, "src/auth.ts", 100), null);
});

test("an added line whose content starts with +++ is not mistaken for a header", () => {
  const diff = [
    "diff --git a/m.md b/m.md",
    "--- a/m.md",
    "+++ b/m.md",
    "@@ -1,1 +1,2 @@",
    " title", // 1 ctx
    "+++ not a header, just markdown", // 2 add — content begins with +++
  ].join("\n");
  const idx = buildDiffAnchorIndex(diff);
  const m = idx.get("m.md");
  assert.ok(m);
  assert.equal(m!.commentable.has(2), true);
  // The file is still `m.md`, not the bogus path from the content line.
  assert.equal(idx.has("not a header, just markdown"), false);
});

test("a deleted file (+++ /dev/null) yields no commentable lines", () => {
  const diff = [
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-const a = 1;",
    "-const b = 2;",
  ].join("\n");
  const idx = buildDiffAnchorIndex(diff);
  assert.equal(idx.size, 0);
});

test("reviewEvent maps the verdict", () => {
  assert.equal(reviewEvent(2), "REQUEST_CHANGES");
  assert.equal(reviewEvent(0), "COMMENT");
  assert.equal(reviewEvent(0, true), "APPROVE");
  assert.equal(reviewEvent(1, true), "REQUEST_CHANGES");
});

test("buildReviewPayload anchors, partitions unanchored, and counts must-fix for the verdict", () => {
  const payload = buildReviewPayload({
    diff: DIFF,
    summary: "Splus review.",
    findings: [
      { id: "f-1", tier: "must-fix", file: "src/auth.ts", line: 12, body: "case-sensitive compare" },
      { id: "f-2", tier: "concern", file: "src/db.ts", line: 1, body: "unused import" },
      // Out-of-diff finding (an unchanged caller) — can't be inline.
      { id: "f-3", tier: "nit", file: "src/auth.ts", line: 500, body: "caller assumes old shape" },
    ],
  });

  assert.equal(payload.event, "REQUEST_CHANGES"); // one must-fix
  assert.equal(payload.comments.length, 2);
  assert.equal(payload.unanchored.length, 1);
  assert.equal(payload.unanchored[0]!.id, "f-3");

  // The id marker is appended so a re-review can find and skip its own comments.
  const c0 = payload.comments.find((c) => c.line === 12)!;
  assert.ok(c0.body.includes(commentMarker("f-1")));
  assert.equal(c0.path, "src/auth.ts");
  assert.equal(c0.side, "RIGHT");
});

test("buildReviewPayload approves a clean review when opted in", () => {
  const payload = buildReviewPayload({
    diff: DIFF,
    summary: "Looks good.",
    approveWhenClean: true,
    findings: [{ tier: "nit", file: "src/db.ts", line: 1, body: "tiny nit" }],
  });
  assert.equal(payload.event, "APPROVE");
  assert.equal(payload.comments.length, 1);
  // No id → no marker appended.
  assert.equal(payload.comments[0]!.body, "tiny nit");
});
