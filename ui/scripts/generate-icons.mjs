// Rasterizes the placeholder PWA icons from public/icons/icon-source*.svg.
// Re-run via `npm run icons:generate` after swapping in real brand artwork.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const iconsDir = dirname(fileURLToPath(import.meta.url)).replace(/scripts$/, "public/icons");

function render(srcName, outName, size) {
  const svg = readFileSync(join(iconsDir, srcName), "utf8");
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  writeFileSync(join(iconsDir, outName), resvg.render().asPng());
  console.log(`wrote ${outName} (${size}x${size})`);
}

render("icon-source.svg", "icon-192.png", 192);
render("icon-source.svg", "icon-512.png", 512);
render("icon-source-maskable.svg", "icon-maskable-512.png", 512);
