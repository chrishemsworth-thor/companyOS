# Brand assets

The CompanyOS logomark and the derived artwork for external profiles. Kept in
the repo so there is one place these come from, rather than a folder on
somebody's laptop.

## The mark

A rounded square carrying a bold sans-serif **C**. Two orientations, both in use:

| Orientation | Square | Letter | Where it is used |
|---|---|---|---|
| **Dark** (canonical) | `#16181d` | `#ffffff` | The console sidebar brand (`Brand()` in `ui/src/components/Layout.tsx`, via `bg-accent` / `text-accent-contrast`), and anywhere the mark sits on a light background |
| **Light** (inverted) | `#ffffff` | `#16181d` | The browser favicon in `ui/index.html` and the PWA icons in `ui/public/icons/`, both of which render against dark browser chrome |

> **This is still placeholder artwork.** `ui/scripts/generate-icons.mjs` says so
> in its header, and it is true here too: the mark is a system-font letter in a
> rounded rectangle, not a drawn logotype. It holds up in a favicon and it will
> do to launch a profile page, but it wants replacing with real brand work
> before it goes in front of customers. When that happens, swap
> `ui/public/icons/icon-source*.svg`, re-run `npm run icons:generate` in `ui/`,
> and regenerate this folder (below).

## Palette

Taken from `ui/src/styles.css` — these are the theme tokens, not new values.

| Token | Light theme | Dark theme | Role |
|---|---|---|---|
| `--accent` | `#16181d` | `#e8eaed` | The mark's square |
| `--accent-contrast` | `#ffffff` | `#0f1116` | The letter |
| `--bg` | `#ffffff` | `#0f1116` | Surface behind it |
| `--accent-soft` | `#eef0f3` | `#262b35` | Quiet fills |

Muted text on the dark cover is `#9aa2b1`, with `#6b7482` for the secondary
line.

## Files

| File | Size | Purpose |
|---|---|---|
| `logo-dark.svg` | vector | Source — canonical dark mark |
| `logo-light.svg` | vector | Source — inverted mark |
| `cover.svg` | vector | Source — social cover, sized for LinkedIn |
| `companyos-logo-300.png` | 300×300 | LinkedIn page logo (300×300 is both its minimum and its display size) |
| `companyos-logo-400.png` | 400×400 | Spare raster at higher resolution |
| `companyos-logo-light-300.png` | 300×300 | Inverted mark, for dark backgrounds |
| `companyos-linkedin-cover-1128x191.png` | 1128×191 | LinkedIn page cover |

The PWA icons are **not** duplicated here — they live at
`ui/public/icons/` because the manifest references them by path, and copying
them would create a second source of truth.

## Regenerating the rasters

The SVGs are the source; the PNGs are built from them with the same renderer
that builds the PWA icons (`@resvg/resvg-js`, a `ui/` dependency).

```sh
cd ui && npm install     # if node_modules is not present
node --input-type=module - <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
const dir = "../docs/brand/";
const render = (src, out, width) => {
  const r = new Resvg(readFileSync(dir + src, "utf8"), { fitTo: { mode: "width", value: width } });
  writeFileSync(dir + out, r.render().asPng());
};
render("logo-dark.svg", "companyos-logo-300.png", 300);
render("logo-dark.svg", "companyos-logo-400.png", 400);
render("logo-light.svg", "companyos-logo-light-300.png", 300);
render("cover.svg", "companyos-linkedin-cover-1128x191.png", 1128);
EOF
```

The SVGs name `Liberation Sans` ahead of `Helvetica, Arial` in their font
stacks. That is deliberate: Liberation Sans is metrically identical to Arial and
is what Linux build environments actually have installed, so the rendered PNGs
match the mark as it appears in the console rather than falling back to
whatever serif the renderer picks first.
