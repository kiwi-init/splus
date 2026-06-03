# Security Policy

Splus is a security-adjacent tool, so we hold it to a high bar.

## Privacy posture

Splus is **100% local by design**. The deterministic engine and the MCP server make **no network
calls** — your code and diffs never leave your machine. The two exceptions are explicit and opt-in:

- the optional **LLM layer** (`llm: true`) talks only to the provider you configure;
- the optional **osv-scanner** adapter queries the public OSV vulnerability database, and only when
  a dependency lockfile changed.

No account, no token, no telemetry, no phone-home.

## Reporting a vulnerability

If you find a security issue in Splus itself (e.g. a way to make the engine execute attacker code,
exfiltrate a diff, or a flaw in the secret/sink detectors), **please do not open a public issue.**

Report it privately via [GitHub's security advisories](https://github.com/kiwi-init/splus/security/advisories/new),
or email **security@kiwiinit.com**. We'll acknowledge within a few days and keep you updated on the
fix and disclosure timeline.

When reporting, please include: what you found, how to reproduce it, and the impact you see.

## Supported versions

Splus is pre-1.0 and moves fast. Security fixes land on the latest release; please upgrade by
re-running the installer (`curl -fsSL https://splus.sh/install.sh | sh`) before reporting.
