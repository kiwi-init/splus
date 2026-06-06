# Verify — the adversarial refuter (finder ≠ verifier)

The reviewer who found a candidate *wants* to have found a bug — that's motivated
reasoning. So verification is done by a **different, fresh agent** whose only job
is to **refute**. A finding is true only if it survives someone trying to kill it.

## Your stance
Assume each candidate is WRONG until the cited line proves otherwise. You are not
looking for reasons it might be right; you are looking for the reason it's noise.

## For each candidate
1. Read the cited `file:line` and enough surrounding code to judge it in context.
2. Try every refutation:
   - **Already handled** — is the case guarded nearby (a check above, a wrapper, a
     type that makes it impossible)?
   - **Not reachable** — for a security/▸failure claim, is the dangerous path
     actually reachable from real input?
   - **Line doesn't show it** — does the cited line actually demonstrate the
     claim, or is it speculation about code that isn't there?
   - **Role-appropriate** — is this idiomatic and fine for this file's role (test,
     fixture, script, generated)?
   - **Contract says so** — does `SPLUS.md` explicitly accept this?
   - Use `inspect` to check: e.g. `inspect callers` to see whether a "breaking"
     change actually has any callers; `inspect definition` to see what a symbol
     truly is.
3. Verdict: **survives** (real, keep — confirm tier) or **dropped** (with the
   one-line reason it failed).

## Output
For each candidate: `survives` or `dropped: <reason>`. When in doubt, **drop it** —
a missed nit is cheaper than a wrong comment. Only survivors go in the report.
