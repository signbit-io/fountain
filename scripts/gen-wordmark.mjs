// Generates docs/assets/wordmark-{light,dark}.svg — the "SignBit" WORDMARK for the README.
//
// Same approach as gen-icon.mjs: Sabre Shark Bold Italic converted to OUTLINE PATHS via
// opentype.js, so the TTF is never embedded and any renderer (GitHub's included) draws it
// identically with no font dependency.
//
// Two variants because GitHub serves README images on either a light or a dark page and
// cannot restyle them: <picture> + prefers-color-scheme picks one. The only difference is
// the "SigN" half — orange "Bit" is constant, it is the brand colour on both grounds.
//
// ⚠️ The lockup is "SigN" + "Bit" with a CAPITAL N, matching the platform's
// Wordmark.tsx: a lowercase "n" reads oddly in this face. Do not "correct" it to "Sign".
//
// Run: node scripts/gen-wordmark.mjs
//
// ⚠️ Sabre Shark ships under a non-commercial license — a commercial license must be secured
// before any public release. Outlining does not change that; it only removes the font FILE
// from the artifact.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import opentype from 'opentype.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FONT = join(root, 'src/assets/fonts/sabreshark-bold-italic.ttf')
const OUTDIR = join(root, 'docs/assets')

const font = opentype.parse(readFileSync(FONT).buffer)

// opentype.js 2.0's Path.toPathData() emits NaN for some of this font's curve segments —
// serialize the command list ourselves (same workaround as gen-icon.mjs).
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

const EM = 560
// Draw the two halves as one continuous run so the italic sidebearings stay correct —
// measuring "Sign" and "Bit" separately and re-joining them would open a seam.
const signPath = font.getPath('SigN', 0, 0, EM)
const bitPath = font.getPath('Bit', font.getAdvanceWidth('SigN', EM), 0, EM)

const a = signPath.getBoundingBox()
const b = bitPath.getBoundingBox()
const x1 = Math.min(a.x1, b.x1)
const x2 = Math.max(a.x2, b.x2)
const y1 = Math.min(a.y1, b.y1)
const y2 = Math.max(a.y2, b.y2)
const w = x2 - x1
const h = y2 - y1

// Pad so the italic's overhang and any antialiasing never clip at the viewBox edge.
const PAD = EM * 0.06
const vbW = w + PAD * 2
const vbH = h + PAD * 2
const tx = PAD - x1
const ty = PAD - y1

console.log(`wordmark box ${w.toFixed(0)}x${h.toFixed(0)} → viewBox ${vbW.toFixed(0)}x${vbH.toFixed(0)}`)

const ORANGE = '#f7931a'
const INK_LIGHT = '#16181f'  // near-black, for a light page
const INK_DARK = '#f0f1f5'   // near-white, for a dark page

function svg(ink, variant) {
  return `<!--
  SignBit wordmark (${variant}) — GENERATED, do not hand-edit.
  Regenerate with: node scripts/gen-wordmark.mjs
  Sabre Shark Bold Italic as outline paths (no font dependency at render time).
  Lockup: "SigN" in ink, "Bit" in brand orange (capital N is deliberate — matches the
  platform's Wordmark.tsx). Sabre Shark ships non-commercial;
  commercial license pending.
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW.toFixed(2)} ${vbH.toFixed(2)}" role="img" aria-label="SignBit">
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)})">
    <path fill="${ink}" d="${toD(signPath)}"/>
    <path fill="${ORANGE}" d="${toD(bitPath)}"/>
  </g>
</svg>
`
}

mkdirSync(OUTDIR, { recursive: true })
writeFileSync(join(OUTDIR, 'wordmark-light.svg'), svg(INK_LIGHT, 'light page'))
writeFileSync(join(OUTDIR, 'wordmark-dark.svg'), svg(INK_DARK, 'dark page'))
console.log('wrote docs/assets/wordmark-{light,dark}.svg')
