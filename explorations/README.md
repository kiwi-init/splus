# explorations/ — HTML review report

Iterating on what Splus hands back after a review: instead of (only) terminal/JSON,
emit a **self-contained HTML report** that's intuitive for a dev to skim.

## Design rules (locked)
- **Black on white.** Color is reserved for accents only:
  severity dots, the merge-confidence meter, diff add/del, blast-radius edges.
- **Monospace, hairline borders, lots of whitespace** — matches the Conductor-inspired
  monochrome aesthetic. No gradients, no chrome.
- **One file, no CDN.** Splus is local-only/offline — CSS + JS + the impact graph are all inline.
  Open the file directly, no server.
- **The graph is the centerpiece.** Files = nodes, dependency/impact = edges, hover traces blast radius.
  This is what makes file/function relationships "click" for a dev.

## Files
- `splus-report.html` — v1, rendering the g-cloud PR (#25579732) mapped onto Splus's real schema.

## Data → HTML mapping (so the agent can generate this)
Everything is driven by the existing `Report` / `Finding` model (`crates/splus-engine/src/model.rs`)
and the MCP `review` output. Nothing new is invented:

| Report field                      | Where it renders                                  |
|-----------------------------------|---------------------------------------------------|
| `summary.must_fix/concern/nit`    | verdict chip + stat tiles                         |
| `finding.severity` / `tier`       | severity dot + tier pill on each finding          |
| `finding.file` + `region`         | `file : startLine–endLine` location line          |
| `finding.title` / `message`       | finding heading + body                            |
| `finding.category` / `rule_id`    | pills                                             |
| `finding.anchor.{kind,detail}`    | provenance pill (sarif / graph-edge / heuristic…) |
| `finding.confidence`              | confidence bar (0..1)                             |
| `finding.suggestion`              | "Suggested fix" diff block                        |
| `finding.blast_radius`            | **the impact graph** (nodes, edges, tooltip)      |
| `blast_radius.resolution_method`  | footer "adapters absent / heuristic" note         |
| `summary.collectors_run/absent`   | footer                                            |

The graph data lives in the inline `DATA = { nodes, edges }` object at the bottom of the HTML —
that's the only thing the engine needs to serialize per review.

## The instruction we inject after a review
See `report-prompt.md` — the block we append to the reviewing agent's turn telling it to
render findings into this template.

## Open it
```
open explorations/splus-report.html
```
