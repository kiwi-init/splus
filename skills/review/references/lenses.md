# Lenses — the failure modes a thorough reviewer checks

Apply every lens to a unit. For a large unit, fan out one fresh sub-agent per
lens (each blind to the others) so redundancy doesn't crowd out coverage — a
reviewer looking only for races finds races a generalist skims past.

Every finding, in every lens, must cite a real changed line and survive a
refutation. Ground it with `inspect` rather than asserting it.

Spend the comment budget on the **change's own logic**. Generic best-practice
padding — timing-safe comparison, rate limiting, header normalization, hardening
on trusted paths — is the #1 source of review noise; raise it only when the diff
itself clearly introduces the flaw.

## Contract drift — the most-missed real-bug class
For EVERY changed function (the `review` output lists the changed exported
symbols deterministically — start there):
1. **Enumerate what it returns/throws on every path** after the change — success,
   error, missing/invalid input, each early return — with the *exact shape*:
   object keys, wrapper types (`{success,data,error}`), `Response` vs parsed
   body, promise vs value, sentinel/fallback values.
2. **Open every call site** (`inspect callers`, then read each one) and state
   what shape that caller assumes — property accesses, destructuring,
   truthiness checks.
3. **Report every mismatch.** One changed function often breaks several callers;
   finding one mismatch means checking the remaining call sites, not stopping.

## Correctness
Off-by-one and boundary errors; missing `await` / unhandled rejection; a swallowed
or mis-handled error path; wrong condition or inverted boolean; a case-sensitive
comparison where the input's case varies; null/undefined deref; resource leak
(unclosed handle, unbounded growth); a broken invariant the surrounding code
relies on; an early return that skips required cleanup; validation that diverges
between the read path and the write path.

## Security
Injection (SQL / command / template) reachable from input; path traversal; SSRF;
auth/authz gaps and IDOR; unsafe deserialization; secret or credential handling;
`eval`/dynamic require of attacker-influenced data; missing output encoding. Trace
from the input to the sink — is the path actually reachable?

## Intent
Does the code do what its name, comments, and the change's stated purpose claim?
Look for: dead or unreachable branches; logic that contradicts a comment;
fail-OPEN where it should fail-CLOSED; a "fix" that doesn't address the described
problem; a renamed thing whose behavior silently changed.

## Failure & concurrency
Races and check-then-act gaps; partial writes / non-atomic updates; retries that
aren't idempotent (double-charge, double-send); shared mutable state across async;
timeouts and cancellation; what happens when the dependency is down — does it
degrade safely?

## Blast radius
For every changed export or signature, `inspect callers` / `inspect blast_radius`
and **open each call site**: does the change still hold for it? Did a default
change, a field disappear, a thrown error newly escape, an argument order shift?
Cross-API-boundary changes (routes/handlers/public API) get the most scrutiny.
This is the lens determinism grounds best — use the engine, then verify by reading.
