# @splus/landing

The **S+** marketing landing page for `splus.sh`. **Next.js 16 (App Router) + Tailwind 4.**
Oscilloscope / signal-lab aesthetic, cohesive with the dashboard.

```
app/
  layout.tsx     fonts (next/font), metadata, <html class="js">
  page.tsx       all sections (hero → install → precision → how → moat → run → compare → trust → cta)
  globals.css    Tailwind import + the full design system (mint signal / coral noise)
components/
  Interactions.tsx   reveal-on-scroll, terminal tabs, copy-to-clipboard, live readout
public/          favicon.svg, og.svg
```

## Local

```bash
pnpm --filter @splus/landing dev      # http://localhost:3000
```

## Deploy to Vercel (splus.sh)

1. New Project → import `kiwi-init/splus`.
2. **Root Directory:** `packages/landing`
3. **Framework Preset:** Next.js (auto-detected). Leave Build/Install/Output at defaults.
4. Add the domain **`splus.sh`** (apex). Nameservers are already on Vercel, so it attaches automatically.

No `vercel.json` needed — Vercel detects Next.js and builds it zero-config.

## Notes

- The hero install command markets `claude mcp add splus -- npx -y @splus/mcp`. Publish
  `@splus/mcp` to npm for that to work as-is; until then, local testing uses the built path.
- `og.svg` is an SVG card; generate a raster (`og.png`) for production and swap the `og:image`.
