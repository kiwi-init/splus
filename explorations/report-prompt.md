# Report instruction (injected after `review` returns)

This is the text we append to the reviewing agent's context once findings are ready.
It tells the agent to render the report — it does **not** ask the agent to invent layout or styling
(the template and CSS are fixed; the agent only fills data).

---

> You have finished the review. Now produce a **standalone HTML report** at
> `splus-report.html` using the provided template (`explorations/splus-report.html`).
>
> **Rules — do not deviate:**
> - **Black text on white background.** Use color *only* for accents already defined in the
>   stylesheet: severity dots, the confidence meter, diff add/del lines, and blast-radius edges.
>   Do not add new colors, gradients, or backgrounds.
> - The report is **one self-contained file** — all CSS and JS inline, **no external/CDN links**
>   (it must open offline).
> - Keep the section order: **Verdict → Summary → Impact graph → Findings → Files changed → Footer.**
>
> **Fill these from the review result (do not paraphrase severities or invent findings):**
> 1. **Verdict chip** — `SAFE TO MERGE` only if `summary.must_fix == 0`; otherwise `CHANGES REQUESTED`
>    (red) with the must-fix count. Merge confidence = the 1–5 mapping of overall confidence.
> 2. **Stat tiles** — `files_changed`, `added_lines`, `must_fix`, `concern`, `nit`, `suppressed`.
>    A tile only takes its accent color when its count > 0.
> 3. **Impact graph** — populate the inline `DATA = { nodes, edges }` object:
>    - one node per changed file; `hub:true` on the file with the largest `blast_radius`.
>    - `badge` = number of findings on that file (`badgeKind:"cn"` if any concern, else `"nit"`).
>    - edges from `blast_radius.files_affected` and import/caller relationships, arrow in the
>      direction impact propagates.
>    - node tooltip = `direct_callers`, `transitive_callers`, `files_affected`, `crosses_api_boundary`.
> 4. **Findings** — one card each, in tier order (must-fix → concern → nit). Render
>    `title`, `file:region`, `message`, `category`/`rule_id`/`anchor` pills, the `confidence` bar,
>    and `suggestion` as a diff block (added lines `+`, removed lines `-`).
> 5. **Footer** — `collectors_run`, `adapters_absent`, and any `notes` (e.g. heuristic vs SCIP
>    resolution, so the dev knows how trustworthy the caller counts are).
>
> If a finding has no `suggestion`, omit the diff block. If `blast_radius` is null for every file,
> render the graph with import-only edges and no tooltips for callers.
> When done, tell the user the path and that it opens offline.

---

### Why HTML (not just markdown)
- The **impact graph** can't render in a terminal — node-link + hover trace is the whole point:
  it makes "what does this change touch" legible at a glance.
- Diff-styled suggestions, confidence bars, and the verdict meter read faster than prose.
- Self-contained file = shareable artifact a dev can keep next to the PR.
