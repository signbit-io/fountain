// Generates src-tauri/icons/source-icon.svg — the app-icon SOURCE: "SB" set in the real
// brand wordmark face (Sabre Shark Bold Italic) converted to OUTLINE PATHS via opentype.js
// (devDependency), so the TTF is never embedded and any SVG rasterizer renders it
// identically. Split like the wordmark lockup: S = ink-white, B = brand orange, on the
// dark app-surface gradient + .bg-glow-style orange bloom + hairline card-style border.
//
// Run:            node scripts/gen-icon.mjs
// Then regenerate: npx tauri icon src-tauri/icons/source-icon.svg
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

// Draw at a working em size, measure the combined S+B box, then scale+center it so the
// mark spans ~78% of the 1024 canvas width (Sabre Shark is a WIDE face — unscaled "SB"
// at a legible height overflows the tile).
const SIZE = 560
const sPath = font.getPath('S', 0, 0, SIZE)
const gap = SIZE * 0.02
const bPath = font.getPath('B', font.getAdvanceWidth('S', SIZE) + gap, 0, SIZE)

const sBox = sPath.getBoundingBox()
const bBox = bPath.getBoundingBox()
const x1 = Math.min(sBox.x1, bBox.x1)
const x2 = Math.max(sBox.x2, bBox.x2)
const y1 = Math.min(sBox.y1, bBox.y1)
const y2 = Math.max(sBox.y2, bBox.y2)
const w = x2 - x1
const h = y2 - y1

const TARGET_W = 1024 * 0.78
const scale = Math.min(TARGET_W / w, (1024 * 0.5) / h)
// Center the scaled box at (512, 512).
const tx = 512 - scale * (x1 + w / 2)
const ty = 512 - scale * (y1 + h / 2)

console.log(`glyph box ${w.toFixed(0)}x${h.toFixed(0)} → scale ${scale.toFixed(3)}`)

/*
  ANDROID ADAPTIVE-ICON FOREGROUND — a SECOND, smaller mark.

  ⚠️ Why this exists: Android composites an adaptive icon on a 108x108dp canvas but only
  GUARANTEES the centre 72x72dp is visible. The outer ~33% is a bleed area the launcher may
  mask away entirely so it can crop the icon to a circle / squircle / rounded square to match
  the device theme. Anything outside that safe zone gets clipped — which is exactly what
  happened here: the full-bleed mark spans 78% of the tile, well past the 66% safe zone, so
  the S and B were cut off on the phone's home screen.

  So the adaptive foreground draws the SAME mark at ~56% (a ~28% shrink) with a transparent
  background — the launcher supplies the shaped background itself. The full-bleed icon above
  is unchanged and still correct for desktop (Windows/macOS/Linux) and the web favicon, none
  of which are masked. Two outputs, deliberately, because they have genuinely different
  geometry constraints.
*/
const ADAPTIVE_TARGET_W = 1024 * 0.56
const aScale = Math.min(ADAPTIVE_TARGET_W / w, (1024 * 0.36) / h)
const aTx = 512 - aScale * (x1 + w / 2)
const aTy = 512 - aScale * (y1 + h / 2)

const svg = `<!--
  SignBit Companion Signer app icon SOURCE (1024x1024) — GENERATED, do not hand-edit.
  Regenerate with: node scripts/gen-icon.mjs   (then: npx tauri icon src-tauri/icons/source-icon.svg)
  "SB" = Sabre Shark Bold Italic converted to outline paths (no font dependency at render
  time); split like the wordmark lockup (S ink-white, B brand orange) on the dark
  app-surface gradient + orange glow. Sabre Shark ships non-commercial; commercial license pending.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16181f"/>
      <stop offset="1" stop-color="#0b0c10"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.08" r="0.9">
      <stop offset="0" stop-color="#f7931a" stop-opacity="0.30"/>
      <stop offset="0.55" stop-color="#f7931a" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#f7931a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" rx="120" fill="url(#bg)"/>
  <rect width="1024" height="1024" rx="120" fill="url(#glow)"/>
  <rect x="16" y="16" width="992" height="992" rx="106" fill="none" stroke="#f7931a" stroke-opacity="0.20" stroke-width="10"/>
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">
    <path fill="#f0f1f5" d="${toD(sPath)}"/>
    <path fill="#f7931a" d="${toD(bPath)}"/>
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
    <path fill="#f0f1f5" d="${toD(sPath)}"/>
    <path fill="#f7931a" d="${toD(bPath)}"/>
  </g>
</svg>
`
const ADAPTIVE_OUT = join(root, 'src-tauri/icons/android-foreground.svg')
writeFileSync(ADAPTIVE_OUT, adaptiveSvg)
console.log('wrote', ADAPTIVE_OUT, `(adaptive foreground, scale ${aScale.toFixed(4)})`)
