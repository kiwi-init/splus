# @splus/dashboard

The **S+** review console + public Trust Center for `dash.splus.sh`.
**Next.js 16 (App Router) + Tailwind 4.** Same oscilloscope aesthetic as `splus.sh`.

> Renders clearly-labeled **SAMPLE** data (`lib/data.ts`) so the console is populated
> out of the box. The real data layer — Postgres/pgvector behind the same shapes, fed by
> the GitHub App — wires in behind these components later. Honesty is the brand: every
> seeded metric is badged `sample`.

```
app/
  layout.tsx                  shell (rail + main), fonts, metadata
  page.tsx                    Overview — org precision, repo list
  repo/[owner]/[name]/page.tsx  Repo detail — the precision-over-time hero chart + config + learnings
  billing/page.tsx            Transparent per-author usage meter
  trust/page.tsx              Public Trust Center
  globals.css                 Tailwind import + design system
components/  Rail, Chart, ConfigForm, Learnings, Stat
lib/data.ts                   sample data + shapes (RepoData, Week, Billing, …)
```

## Local

```bash
pnpm --filter @splus/dashboard dev    # http://localhost:3000
```

## Deploy to Vercel (dash.splus.sh)

1. New Project → import `kiwi-init/splus`.
2. **Root Directory:** `packages/dashboard`
3. **Framework Preset:** Next.js (auto-detected). Defaults are correct.
4. Add the domain **`dash.splus.sh`** (subdomain).

No `vercel.json` needed — Vercel detects Next.js and builds it zero-config.
