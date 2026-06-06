---
name: Splus Preferences
description: This skill should be used when the user wants to set up or change how Splus reviews this repo — "add a splus nit", "splus should never flag X", "set up SPLUS.md", "tell splus to skip generated files", "splus review preferences".
user-invocable: true
allowed-tools:
  - mcp__splus__preferences
  - mcp__splus__learnings
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# Splus Preferences — author `SPLUS.md`

`SPLUS.md` is the repo's review contract. Splus reads it **first** on every
review: the prose guides the reviewer; a small structured subset is **binding**.
Repo `./SPLUS.md` layers over the user's `~/.splus/SPLUS.md`.

## What goes in it
- **Prose** (injected into the reviewer, soft-binding): policy, conventions, nits,
  hotspots, voice. e.g. "we use `Result<T,E>`, never throw", "tests may use `any`",
  "lead with the worst thing, no praise padding".
- **Binding directives** (enforced — matching findings are dropped at review time,
  and reported as dropped, never silently):
  - `mute: <ruleId>` — drop every finding from that rule (e.g. `mute: hygiene.console-log`).
  - `skip: <glob>` — drop findings under a path (`**` spans dirs, `*` within a
    segment), e.g. `skip: generated/**`, `skip: examples/keys.sample.env`.

## To create one
1. Check for an existing `./SPLUS.md` (Read it) and run `preferences` to see what's
   active. Also glance at `learnings` — patterns already dismissed/muted are good
   candidates to promote into a durable `mute:`.
2. Infer the repo's conventions from its code (test layout, error style, generated
   dirs) and from what the user tells you.
3. Write `./SPLUS.md` using the template below. Confirm the binding rules with the
   user before adding them — they silently drop findings.

## Template
```markdown
# SPLUS.md — how this repo wants to be reviewed

## policy
- signal budget: keep it tight; lead with the worst thing.
- scrutiny: billing/** and auth/** get max scrutiny.

## nits & conventions
- We use Result<T,E>, not exceptions — don't flag missing try/catch.
- Tests may use `any`; fixtures are not reviewed.
- mute: hygiene.console-log        <!-- console.log is fine in this repo -->

## skip
- skip: generated/**
- skip: **/*.pb.go
- skip: examples/keys.sample.env

## voice
terse. no praise padding.
```

When you add a `mute:`/`skip:`, tell the user exactly what will stop being flagged.
To make a one-off correction instead, prefer `dismiss`/`mute` from the review flow;
use `SPLUS.md` for the standing contract.
