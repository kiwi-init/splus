---
name: Splus PR Review
description: This skill should be used when the user wants the review to land ON a GitHub pull request — "review PR #123", "review this pull request and post comments", "leave a Splus review on the PR", "post the review to GitHub", "approve/request changes on the PR". Runs the agent-led Splus protocol against the PR's base..HEAD diff, then posts the verified survivors as a real GitHub PR review (inline comments + verdict) with `gh`. No API key.
user-invocable: true
allowed-tools:
  - mcp__splus__review
  - mcp__splus__inspect
  - mcp__splus__floor
  - mcp__splus__preferences
  - mcp__splus__recall
  - mcp__splus__prReview
  - mcp__splus__report
  - mcp__splus__dismiss
  - mcp__splus__accept
  - mcp__splus__note
  - mcp__splus__mute
  - Task
  - Read
  - Grep
  - Glob
  - Bash
---

# Splus PR Review

The review is the same disciplined, precision-first review the `splus-review`
skill runs — this skill only changes the **input** (a GitHub pull request, not
your working tree) and the **output** (a real PR review with inline comments and
a verdict, not a local HTML file). Everything in between — ground, investigate in
fresh sub-agents, verify by refutation, teach — is identical. **A wrong comment
on someone's PR costs more than a missed nit.** Post nothing you didn't verify.

This needs `gh` authenticated (`gh auth status`). The Splus engine and reasoning
stay 100% local; the only network call is the `gh` round-trip YOU make to post.

## 0. Resolve the PR — what am I reviewing, and where do comments land?

```sh
# Current branch's PR (omit the number), or a specific one:
gh pr view [<number>] --json number,baseRefName,headRefName,headRefOid,url,title,body
git fetch origin <baseRefName>            # ensure the base ref exists locally
```

You need: the **base ref** (drives the diff scope), the PR **number** and repo
**owner/name** (where the review posts), and the **title/body** (the stated
intent — the only narrative your reviewers should trust). If the head isn't
checked out locally, `gh pr checkout <number>` first.

## 1–4. Run the review protocol against the PR diff

Run the full `splus-review` flow, scoped to the PR:

- **Ground:** `review` with `mode:base` and `base:<baseRefName>`. That's the
  PR-correct range (`base...HEAD`, merge-base). Read `SPLUS.md` first — it
  overrides engine defaults and your taste.
- **Investigate:** partition the changed files into units and spawn **fresh
  `Task` sub-agents** that see the diff cold (the protocol in
  `references/investigate.md` of the `splus-review` skill). Hand each only its
  files, the contract, the floor, and the PR title/body — never an
  implementation narrative. Each `inspect`s callers / blast radius / complexity
  and `recall`s prior burns instead of guessing.
- **Verify:** a separate refutation pass re-reads each candidate's cited line and
  drops anything it can't defend (`references/verify.md`). This gate matters more
  here — the survivors become public comments.

Trace every changed exported contract into its callers (return-shape drift is the
most-missed real bug), and post **no checklist padding** — generic hardening that
the diff didn't introduce is noise that wastes a reviewer's attention.

## 5. Emit — land the verified review on the PR

Write each survivor's comment markdown (the **what**): the rationale and a
concrete fix — prefer a GitHub ` ```suggestion ` block so the author can commit it
in one click. Then call **`prReview`** (the deterministic **where**):

```
prReview(
  mode: "base", base: "<baseRefName>",
  approveWhenClean: <true if you'd approve a clean PR, else false>,
  summary: "<your verdict prose — markdown; a mermaid impact graph renders on GitHub>",
  findings: [ { id, tier, file, line, endLine?, body }, … ]   // your VERIFIED survivors
)
```

`prReview` anchors each finding to a real diff line (RIGHT side), folds any
**out-of-diff** finding (an unchanged caller the change breaks) into the summary
instead of dropping it, picks the review **event** from the must-fix count
(`must-fix>0` → `REQUEST_CHANGES`; else `COMMENT`, or `APPROVE` when you opted
in), tags each comment with a hidden `<!-- splus:<id> -->` marker, and hands back
the exact JSON plus the `gh` command. Post it:

```sh
# write the returned PAYLOAD to .splus-cache/pr-review.json, then:
gh api repos/{owner}/{repo}/pulls/{number}/reviews --method POST --input .splus-cache/pr-review.json
```

- **Verdict prose** opens the summary: SAFE TO MERGE (0 must-fix) or CHANGES
  REQUESTED with the count, then 1–3 sentences on what you reviewed and how blast
  radius resolved (heuristic vs SCIP). The mermaid graph (modules = nodes, impact
  = edges) is the PR-native version of the HTML report's centerpiece.
- **A 422 on a comment** means that line left the diff since you reviewed —
  re-run `review` on the current head (`headRefOid`) and rebuild the payload.
- **Re-review on a pushed update:** don't double-post. First minimize/resolve
  your prior Splus comments (they carry the `<!-- splus:<id> -->` marker), or skip
  ids already present on the PR. Reviewing only the new commits keeps it quiet.

> The HTML `report` and `prReview` are siblings, not rivals: `report` is the
> offline artifact a dev keeps next to the diff; `prReview` is the review that
> lives on the PR. Use `prReview` when the deliverable is the pull request itself.

## 6. Teach — make diligence compound

- `dismiss <id>` when the author convincingly pushes back (it was noise).
- `accept <id>` when they act on a real finding (reinforces + becomes recallable).
- `note "<convention>"` for anything you learned about the repo.
- `mute <ruleId>` when a whole class is unwanted here.

## The standard you're held to
Same as `splus-review`, raised: every posted comment cites a real line, survived
a refutation pass, and anchors to the diff. Every floor finding got an explicit
fate. Nothing generic, nothing unverified, nothing silently dropped. The review
that lands on the PR is the one you'd defend in the thread.
