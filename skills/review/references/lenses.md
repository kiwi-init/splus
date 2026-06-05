# Lenses — the failure modes a thorough reviewer checks

Apply every lens to a unit. For a large unit, fan out one fresh sub-agent per
lens (each blind to the others) so redundancy doesn't crowd out coverage — a
reviewer looking only for races finds races a generalist skims past.

Every finding, in every lens, must cite a real changed line and survive a
refutation. Ground it with `inspect` rather than asserting it.

## Correctness
Off-by-one and boundary errors; missing `await` / unhandled rejection; a swallowed
or mis-handled error path; wrong condition or inverted boolean; null/undefined
deref; resource leak (unclosed handle, unbounded growth); a broken invariant the
surrounding code relies on; an early return that skips required cleanup.

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
