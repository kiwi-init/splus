# @splus/landing

The **S+** marketing landing page for `splus.sh`. **Next.js 16 (App Router) + Tailwind 4.**
Oscilloscope / signal-lab aesthetic. Also serves the installer at `splus.sh/install.sh`.

```
app/
  layout.tsx     fonts (next/font), metadata, <html class="js">
  page.tsx       all sections (hero → install → precision → how → moat → local → compare → trust → cta)
  globals.css    Tailwind import + the full design system (mint signal / coral noise)
components/
  Interactions.tsx   reveal-on-scroll, terminal tabs, copy-to-clipboard, live readout
public/          favicon.svg, og.svg, install.sh (copied from the repo root at build time)
```

## Local

```bash
pnpm --filter @splus/landing dev      # http://localhost:3000
```

## Deploy to Vercel (splus.sh)

1. New Project → import `kiwi-init/splus`.
2. **Root Directory:** `packages/landing`
3. **Framework Preset:** Next.js (auto-detected). Leave Build/Install/Output at defaults.
4. Add the domain **`splus.sh`** (apex).

The `prebuild` script copies the repo-root `install.sh` into `public/` so `splus.sh/install.sh`
serves the canonical one-liner.

## Notes

- The hero markets the one-line install: `curl -fsSL https://splus.sh/install.sh | sh`.
- `og.svg` is an SVG card; generate a raster (`og.png`) for production and swap the `og:image`.
