---
name: False positive / noise
about: Splus flagged something it shouldn't have (the most important kind of report)
title: "[FP] "
labels: false-positive
---

**The finding**
Rule id, file:line, and the message Splus emitted.

**Why it's noise**
What makes this not worth a reviewer's comment? (test fixture, intentional idiom, safe-by-context…)

**The code**
A minimal snippet of the flagged line(s) + enough context to see why it's fine.

**Environment**
`splus-engine --version`, OS, language.

> Tip: in the moment, `dismiss <id>` teaches Splus to stop flagging it (and close variants) on your
> repo. This issue helps us fix the rule for *everyone*.
