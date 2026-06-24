/**
 * PR review emission — the deterministic "where" half of landing a Splus review
 * on a GitHub pull request. The agent decides WHAT to say (the finding, the fix,
 * the verdict's prose); this module decides WHERE each comment can legally land
 * and assembles the GitHub Pull Request Reviews API payload. Pure and
 * zero-inference: given the PR's unified diff, it resolves each finding's
 * `file:line` to an anchor the API will accept, or reports it as un-anchorable so
 * the caller folds it into the summary (never silently dropped).
 *
 * GitHub only accepts an inline review comment on a line that appears in the PR
 * diff, identified by `line` (the file's line number) + `side` (RIGHT = the new
 * version, LEFT = the old). Splus findings cite NEW-side lines, so this resolves
 * RIGHT-side anchors only; a finding about an unchanged caller resolves to null
 * and belongs in the summary body, not inline.
 *
 * This lives in `@splus/shared` rather than the Rust engine on purpose: it's the
 * deterministic *rendering* of an output destination (where `gh` is shelled from
 * the TS side), not finding *grounding*. It can move into the engine later
 * without changing this contract.
 */

/** A review action — drives the PR's overall state. */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** A position the GitHub Pull Request Reviews API will accept for an inline comment. */
export interface ReviewAnchor {
  path: string;
  side: "RIGHT";
  /** New-side line the comment anchors to (the END of the range, per the API). */
  line: number;
  /** Set only for a multi-line comment whose start is in the SAME hunk as `line`. */
  start_line?: number;
}

/** Per-file record of which new-side lines a comment can legally anchor to. */
interface FileAnchors {
  /** New-side line numbers present in the diff (added or context) — RIGHT-commentable. */
  commentable: Set<number>;
  /** New-side line → index of the hunk it belongs to (multi-line comments can't cross hunks). */
  hunk: Map<number, number>;
}

/** Index of commentable new-side lines per file, built from a unified diff. */
export type DiffAnchorIndex = Map<string, FileAnchors>;

// `+++ b/path` file header — only meaningful BEFORE a hunk opens (inside a hunk
// an added line of content can also start with `+++`, so state-guard the match).
const FILE_RE = /^\+\+\+ (.+)$/;
// `@@ -old,oldCount +new,newCount @@` — we only need the new-side start.
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Git prefixes the new path with `b/` by default; repo-relative paths drop it. */
function normalizePath(p: string): string {
  if (p.startsWith("b/") || p.startsWith("a/")) return p.slice(2);
  return p;
}

/**
 * Walk a unified diff line-by-line, tracking the running new-side line number, and
 * record every new-side line that appears in the diff (added `+` or context ` `).
 * Those — and only those — are the lines GitHub will accept an inline RIGHT-side
 * comment on. Removed (`-`) lines never advance the new side and aren't included.
 */
export function buildDiffAnchorIndex(diff: string): DiffAnchorIndex {
  const index: DiffAnchorIndex = new Map();
  let file: string | null = null;
  let newLine = 0;
  let hunkIdx = -1;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    // A new file section resets parsing — the next `+++` is a header again.
    if (raw.startsWith("diff --git")) {
      inHunk = false;
      file = null;
      continue;
    }
    // File header is only a header before the first hunk of its section; inside a
    // hunk, a line starting with `+++` is added CONTENT and must not match here.
    if (!inHunk) {
      const fileMatch = raw.match(FILE_RE);
      if (fileMatch) {
        const target = fileMatch[1]!;
        // `+++ /dev/null` is a deletion: no new side to comment on.
        file = target === "/dev/null" ? null : normalizePath(target);
        continue;
      }
    }
    const hunkMatch = raw.match(HUNK_RE);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      hunkIdx++;
      inHunk = true;
      continue;
    }
    if (!inHunk || file === null) continue;

    const marker = raw[0];
    if (marker === "\\") continue; // "\ No newline at end of file" — not a real line
    if (marker === "-") continue; // removed (LEFT only) — doesn't advance the new side
    if (marker === "+" || marker === " " || raw === "") {
      // added, context, or a blank context line: present on the new side, commentable.
      const fa = index.get(file) ?? { commentable: new Set<number>(), hunk: new Map<number, number>() };
      fa.commentable.add(newLine);
      fa.hunk.set(newLine, hunkIdx);
      index.set(file, fa);
      newLine++;
    }
    // Anything else inside a well-formed hunk shouldn't occur — ignore defensively.
  }
  return index;
}

/**
 * Resolve a finding's `file:startLine[..endLine]` to a GitHub review anchor, or
 * `null` when no part of the range appears in the diff (an out-of-diff finding —
 * e.g. an unchanged caller the change breaks — which the caller surfaces in the
 * summary instead). Anchors `line` to the END of the range per the API; sets the
 * multi-line `start_line` only when both ends are commentable AND in the same hunk.
 */
export function anchorFinding(
  index: DiffAnchorIndex,
  file: string,
  startLine: number,
  endLine?: number,
): ReviewAnchor | null {
  const fa = index.get(file);
  if (!fa) return null;
  const end = endLine ?? startLine;
  const lo = Math.min(startLine, end);
  const hi = Math.max(startLine, end);

  const hiOk = fa.commentable.has(hi);
  const loOk = fa.commentable.has(lo);
  if (!hiOk && !loOk) return null;
  if (!hiOk) return { path: file, side: "RIGHT", line: lo };
  if (!loOk || lo === hi) return { path: file, side: "RIGHT", line: hi };
  // Both ends are in the diff but in different hunks: the API rejects a
  // cross-hunk range, so collapse to a single-line comment on the end line.
  if (fa.hunk.get(lo) !== fa.hunk.get(hi)) return { path: file, side: "RIGHT", line: hi };
  return { path: file, side: "RIGHT", line: hi, start_line: lo };
}

/** A verified survivor of the review, ready to post. `body` is agent-authored. */
export interface VerifiedFinding {
  /** Floor/agent id — embedded as a hidden marker so a re-review can dedup. */
  id?: string;
  tier: "must-fix" | "concern" | "nit";
  file: string;
  line: number;
  endLine?: number;
  /** The comment markdown the agent wrote (the "what"): rationale + a fix/suggestion. */
  body: string;
}

/** One inline comment in the reviews-API payload. */
export interface ReviewComment {
  path: string;
  side: "RIGHT";
  line: number;
  start_line?: number;
  body: string;
}

/** The assembled GitHub Pull Request Reviews API request body. */
export interface ReviewPayload {
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
  /** Findings that could not be anchored to a diff line — fold these into `body`. */
  unanchored: VerifiedFinding[];
}

/**
 * The verdict → review state map. Any unresolved must-fix requests changes;
 * a clean review either approves (when the caller opts in) or just comments.
 */
export function reviewEvent(mustFix: number, approveWhenClean = false): ReviewEvent {
  if (mustFix > 0) return "REQUEST_CHANGES";
  return approveWhenClean ? "APPROVE" : "COMMENT";
}

/** Hidden dedup marker appended to a comment body, keyed by finding id. */
export function commentMarker(id: string): string {
  return `<!-- splus:${id} -->`;
}

/**
 * Assemble the reviews-API payload from the verified survivors and the
 * agent-authored summary. Deterministic: it anchors each finding (or files it
 * under `unanchored`), counts must-fix to pick the event, and tags each comment
 * with a hidden id marker for re-review dedup. The caller fills the summary prose
 * (and is expected to weave in the returned `unanchored` findings).
 */
export function buildReviewPayload(args: {
  diff: string;
  findings: VerifiedFinding[];
  summary: string;
  approveWhenClean?: boolean;
}): ReviewPayload {
  const index = buildDiffAnchorIndex(args.diff);
  const comments: ReviewComment[] = [];
  const unanchored: VerifiedFinding[] = [];
  let mustFix = 0;

  for (const f of args.findings) {
    if (f.tier === "must-fix") mustFix++; // verdict counts ALL findings, anchored or not
    const anchor = anchorFinding(index, f.file, f.line, f.endLine);
    if (!anchor) {
      unanchored.push(f);
      continue;
    }
    comments.push({
      ...anchor,
      body: f.id ? `${f.body}\n\n${commentMarker(f.id)}` : f.body,
    });
  }

  return {
    event: reviewEvent(mustFix, args.approveWhenClean),
    body: args.summary,
    comments,
    unanchored,
  };
}
