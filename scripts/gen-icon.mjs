// Generates src-tauri/icons/source-icon.svg — the app-icon SOURCE: "SB" set in the real
// brand wordmark face (Sabre Shark Bold Italic) converted to OUTLINE PATHS via opentype.js
// (devDependency), so the TTF is never embedded and any SVG rasterizer renders it
// identically. Split like the wordmark lockup: S = ink-white, B = brand orange, on the
// dark app-surface gradient + .bg-glow-style orange bloom + hairline card-style border.
//
// Run:            node scripts/gen-icon.mjs
// Then regenerate: npx tauri icon src-tauri/icons/source-icon.svg
// ⚠️ Then UNDO two things `tauri icon` resets on Android: `git checkout` mipmap-anydpi-v26/ic_launcher.xml
//    and values/ic_launcher_background.xml, and re-render every ic_launcher_foreground.png from
//    src-tauri/icons/android-foreground.svg (transparent, inside the 66% safe zone) at its existing size.
//
// ⚠️ Sabre Shark ships under a non-commercial license — a commercial license must be
// secured before any public release.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import opentype from 'opentype.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FONT = join(root, 'src/assets/fonts/sabreshark-bold-italic.ttf')
const OUT = join(root, 'src-tauri/icons/source-icon.svg')

const font = opentype.parse(readFileSync(FONT).buffer)

// opentype.js 2.0's Path.toPathData() emits NaN for some of this font's curve segments —
// serialize the command list ourselves (numbers straight from the glyph, rounded).
function toD(path) {
  const n = (v) => (Math.round(v * 100) / 100).toString()
  let d = ''
  for (const c of path.commands) {
    if (c.type === 'M') d += `M${n(c.x)} ${n(c.y)}`
    else if (c.type === 'L') d += `L${n(c.x)} ${n(c.y)}`
    else if (c.type === 'C') d += `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`
    else if (c.type === 'Q') d += `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`
    else if (c.type === 'Z') d += 'Z'
  }
  return d
}

/*
  STACKED (S over B) — the platform favicon's lockup (the platform's favicon generator), adopted
  for the app icon on 2026-09-27 (user) so the web app and Fountain carry ONE identical mark.
  Sabre Shark is very wide: "SB" side by side is a 3.92:1 strip that only ever fills a quarter
  of a square tile; stacked it is ~1:1, so each letter gets about half the tile's height.
  ⚠️ Keep in step with gen-favicon.mjs — same geometry, same colours, same flat tile.
*/
const SIZE = 560
const sPath = font.getPath('S', 0, 0, SIZE)
const bPath = font.getPath('B', 0, 0, SIZE)
const sBox = sPath.getBoundingBox()
const bBox = bPath.getBoundingBox()
const sW = sBox.x2 - sBox.x1, bW = bBox.x2 - bBox.x1
const sH = sBox.y2 - sBox.y1, bH = bBox.y2 - bBox.y1
const LEAD = Math.max(sH, bH) * 0.14
const w = Math.max(sW, bW)
const h = sH + LEAD + bH
const sTx = (w - sW) / 2 - sBox.x1, sTy = -sBox.y1
const bTx = (w - bW) / 2 - bBox.x1, bTy = -bBox.y1 + sH + LEAD
const glyphs = `<g transform="translate(${sTx.toFixed(2)} ${sTy.toFixed(2)})"><path fill="#f0f1f5" d="${toD(sPath)}"/></g>
    <g transform="translate(${bTx.toFixed(2)} ${bTy.toFixed(2)})"><path fill="#f7931a" d="${toD(bPath)}"/></g>`

const scale = Math.min((1024 * 0.74) / w, (1024 * 0.74) / h)
const tx = 512 - (scale * w) / 2
const ty = 512 - (scale * h) / 2

console.log(`stacked block ${w.toFixed(0)}x${h.toFixed(0)} → scale ${scale.toFixed(3)}`)

/*
  ANDROID ADAPTIVE-ICON FOREGROUND — a SECOND, smaller mark.

  ⚠️ Why this exists: Android composites an adaptive icon on a 108x108dp canvas but only
  GUARANTEES the centre 72x72dp is visible. The outer ~33% is a bleed area the launcher may
  mask away entirely so it can crop the icon to a circle / squircle / rounded square to match
  the device theme. Anything outside that safe zone gets clipped — which is exactly what
  happened here: the full-bleed mark spans 78% of the tile, well past the 66% safe zone, so
  the S and B were cut off on the phone's home screen.

  So the adaptive foreground draws the SAME mark smaller, with a transparent background — the
  launcher supplies the shaped background itself. The full-bleed icon above is unchanged and
  still correct for desktop (Windows/macOS/Linux) and the web favicon, none of which are
  masked. Two outputs, deliberately, because they have genuinely different geometry
  constraints.

  🚨 **THE SAFE ZONE IS A CIRCLE, NOT A SQUARE** (fixed 2026-10-04, user: "taking up all the
  icon … risking some of the S and B cut off"). Only a 66dp-diameter CIRCLE is guaranteed to
  survive every launcher mask, i.e. radius 0.306 of the 108dp canvas. The earlier 0.56 kept
  the mark's BOUNDING BOX inside 66% of the canvas, but a box's corners reach further than
  its sides: the farthest S/B pixel sat at 0.388 from centre, and the mark filled ~84% of
  the visible 72dp icon. At 0.40 the farthest pixel is at ~0.28 (measured from the rendered
  pixels, not the box), so a circular or squircle mask never touches the letters, and the
  mark fills ~60% of the visible icon, the same proportion as the Play listing icon.
*/
const aScale = Math.min((1024 * 0.4) / w, (1024 * 0.4) / h)
const aTx = 512 - (aScale * w) / 2
const aTy = 512 - (aScale * h) / 2

const svg = `<!--
  SignBit Companion Signer app icon SOURCE (1024x1024) — GENERATED, do not hand-edit.
  Regenerate with: node scripts/gen-icon.mjs   (then: npx tauri icon src-tauri/icons/source-icon.svg)
  "SB" = Sabre Shark Bold Italic converted to outline paths (no font dependency at render
  time); split like the wordmark lockup (S ink-white, B brand orange) on the dark
  app-surface gradient + orange glow. Sabre Shark ships non-commercial; commercial license pending.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="180" fill="#16181f"/>
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">
    ${glyphs}
  </g>
</svg>
`
writeFileSync(OUT, svg)
console.log('wrote', OUT)

/*
  The adaptive foreground: same glyphs, ~28% smaller, TRANSPARENT background (the launcher
  draws the shaped background from ic_launcher_background). The orange glow and hairline
  border are deliberately dropped — both are edge treatments that a launcher mask would slice
  through, and the border in particular would render as a stray arc once cropped to a circle.
*/
const adaptiveSvg = `<!--
  SignBit ANDROID ADAPTIVE-ICON FOREGROUND (1024x1024) — GENERATED, do not hand-edit.
  Regenerate with: node scripts/gen-icon.mjs
  Kept INSIDE Android's 66% safe zone: the outer ~33% of an adaptive icon is a bleed area the
  launcher may mask away, so a full-bleed mark gets visibly clipped on the home screen.
  Transparent background by design — the launcher composites its own shaped background.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <g transform="translate(${aTx.toFixed(2)} ${aTy.toFixed(2)}) scale(${aScale.toFixed(4)})">
    ${glyphs}
  </g>
</svg>
`
const ADAPTIVE_OUT = join(root, 'src-tauri/icons/android-foreground.svg')
writeFileSync(ADAPTIVE_OUT, adaptiveSvg)
console.log('wrote', ADAPTIVE_OUT, `(adaptive foreground, scale ${aScale.toFixed(4)})`)
