# @splus/mcp

A **local, zero-network MCP server** for [Splus](https://splus.sh). Your coding agent
(Claude Code, Codex, OpenCode, …) connects to it over stdio and calls its tools; it runs the
**deterministic review engine on your local checkout** and applies this repo's learned
suppressions. No account, no token, nothing leaves your machine.

## How it works

Each tool runs entirely on your machine:

1. it invokes the local `splus-engine` binary on your working tree (read-only, diff-scoped —
   only *new/changed* lines are ever reviewed);
2. it applies this repo's learned suppressions from `.splus-cache/learnings.json`;
3. it returns a `Report` rendered into an agent-facing shape (each finding keeps its `id` so
   the agent can `dismiss` it).

The agent is still the reviewer: Splus supplies precise, deterministic findings (each with a
provenance anchor + cross-file blast radius); the agent reasons over them, surfaces what
matters, and applies fixes. **No LLM runs in this process** — the agent connected over stdio
does the reasoning. No API key, ever.

## Install

The easiest path is the one-line installer, which downloads the engine + this server and
wires it into every coding agent it finds:

```sh
curl -fsSL https://splus.sh/install.sh | sh
```

Or register it manually with your agent — point the command at the installed `splus-mcp`
wrapper (`~/.splus/bin/splus-mcp`):

```jsonc
// Claude Code:  claude mcp add --scope user splus -- ~/.splus/bin/splus-mcp
// Codex (~/.codex/config.toml):
[mcp_servers.splus]
command = "~/.splus/bin/splus-mcp"
// OpenCode (~/.config/opencode/opencode.json):
{ "mcp": { "splus": { "type": "local", "command": ["~/.splus/bin/splus-mcp"], "enabled": true } } }
```

## Configuration

| Env var        | Default       | Notes                                                   |
| -------------- | ------------- | ------------------------------------------------------- |
| `SPLUS_ENGINE` | auto-resolved | Path to the `splus-engine` binary (else found on PATH). |

## Tools

| Tool          | What it does                                                                   |
| ------------- | ------------------------------------------------------------------------------ |
| `review`      | Read `SPLUS.md`, return the deterministic floor + a directive, drive the review. |
| `inspect`     | One code-intelligence question on demand: `definition` · `callers` · `blast_radius` · `complexity` · `exports` · `imports`. |
| `floor`       | Re-ground on the deterministic finding floor for a scope.                       |
| `preferences` | Show the merged `SPLUS.md` contract (repo + `~/.splus`).                        |
| `recall`      | Surface past confirmed findings / conventions relevant to a hunk.               |
| `note`        | Remember a repo convention you discovered (→ `recall`).                         |
| `dismiss`     | Teach Splus a finding is noise (generalizes to close variants).                 |
| `accept`      | Teach Splus a finding was real (reinforces; becomes recallable).                |
| `mute`        | Mute an entire rule for this repo.                                              |
| `learnings`   | List what's been learned on this repo.                                          |
| `report`      | Render the review as a standalone offline HTML report.                          |
| `index`       | Build a SCIP index locally for the precise (compiler-grade) blast radius.       |

Full reference: [docs/TOOLS.md](../../docs/TOOLS.md).

stdout is the MCP protocol channel; everything human-facing goes to stderr or into a tool
result.
