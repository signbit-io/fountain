import type { ComponentType, ReactNode } from 'react'
import type { HelpDiagramId } from '../lib/help-topics'

/*
  Help diagrams: small inline SVGs attached to a Help leaf through `HelpTopic.diagram`
  (lib/help-topics.ts) and drawn by HelpScreen's SubtopicBody above the leaf's text.

  The rules every drawing here keeps, so none of them needs translating or a theme of its own:
  - ⚠️ NO WORDS inside a drawing. Numbers and universal marks (✓ ✗ # = +) only. The leaf's text
    carries the meaning, which is why the whole figure is aria-hidden.
  - Colour comes from currentColor and the theme tokens (ink, ink-muted, line, brand-500, and
    emerald/red for right and wrong, as Alert uses them), so light and dark both just work.
  - Flat and squared like the rest of the app. No gradients, no rounded rectangles.
  - Each drawing stays small (well under 2 KB of markup) and scales to a 320px phone.
  - 🚨 MOTION IS CSS ONLY (`.hd-*` in index.css) AND EVERY ANIMATED ELEMENT'S BASE STYLE IS ITS
    MEANINGFUL STILL FRAME. Reduced motion and Settings' Animations: Off remove the animation
    outright (`animation: none`), so whatever an element looks like without it is what those
    readers get. Never put the "real" state only inside a keyframe.
*/

const at = (x: number, y: number) => `translate(${x} ${y})`
type XY = { x: number; y: number; className?: string }

function Svg({ h, children }: { h: number; children: ReactNode }) {
  return (
    <svg viewBox={`0 0 240 ${h}`} className="block h-auto w-full" fill="none" stroke="currentColor"
      strokeWidth={1.5} aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

/** A number or mark drawn as text (never a word). */
function T({ x, y, className = 'text-ink', children }: XY & { children: ReactNode }) {
  return (
    <text x={x} y={y} textAnchor="middle" fontSize="11" fontWeight="600" fill="currentColor" stroke="none" className={className}>
      {children}
    </text>
  )
}

/** Key, 24 by 12: the bow on the left, two teeth. */
function Key({ x, y, className }: XY) {
  return (
    <g transform={at(x, y)} className={className}>
      <circle cx="6" cy="6" r="5" />
      <path d="M11 6h13M19 6v4M23 6v4" />
    </g>
  )
}

/** Padlock, 10 by 12. */
function Lock({ x, y, className }: XY) {
  return (
    <g transform={at(x, y)} className={className}>
      <rect y="5" width="10" height="7" />
      <path d="M2 5V3a3 3 0 0 1 6 0v2" />
    </g>
  )
}

/** A small document, 14 by 18. */
function Doc({ x, y, className }: XY) {
  return <path className={className} d={`M${x} ${y}h9l5 5v13h-14zM${x + 9} ${y}v5h5`} />
}

/** A phone, w by h, with the home bar. */
function Phone({ x, y, w = 20, h = 36, className }: XY & { w?: number; h?: number }) {
  return (
    <g transform={at(x, y)} className={className}>
      <rect width={w} height={h} />
      <path d={`M${w / 2 - 3} ${h - 4}h6`} />
    </g>
  )
}

function Check({ x, y }: XY) {
  return <path className="text-emerald-600 dark:text-emerald-400" strokeWidth={2} d={`M${x} ${y + 4}l3.5 3.5L${x + 10} ${y}`} />
}

function Cross({ x, y }: XY) {
  return <path className="text-red-600 dark:text-red-400" strokeWidth={2} d={`M${x} ${y}l8 8M${x + 8} ${y}l-8 8`} />
}

/* 2 of 3: three keys feed one vault, and the pair that is lit keeps changing. Each key dims for
   one third of the cycle, a third apart, so two are always lit. Still frame: all three lit. */
function AnyTwoOfThree() {
  return (
    <Svg h={100}>
      {[28, 108, 188].map((x, i) => (
        <g key={x} className="hd-third text-brand-500" style={{ animationDelay: `${-i * 1.5}s` }}>
          <Key x={x} y={8} />
          <path d={`M${x + 12} 26L${112 + i * 8} 58`} />
        </g>
      ))}
      <rect x="100" y="58" width="40" height="34" className="text-ink" />
      <T x={120} y={79}>2/3</T>
    </Svg>
  )
}

/* Paper (one key, no lock), the keystore on this device (keys, locked) and the backup file
   (keys and vaults, locked), side by side. */
function BackupArtifacts() {
  return (
    <Svg h={100}>
      <g className="text-ink">
        <rect x="23" y="6" width="34" height="44" />
        <Phone x={107} y={6} w={26} h={44} />
        <path d="M187 6h18l8 8v36h-26zM205 6v8h8" />
        <Key x={28} y={64} />
        <Key x={94} y={64} />
        <Key x={122} y={64} />
        <Key x={174} y={64} />
        <Key x={202} y={64} />
        <rect x="193" y="82" width="14" height="14" />
        <circle cx="200" cy="89" r="3" />
      </g>
      <path d="M29 14h8M43 14h8M29 22h8M43 22h8M29 30h8M43 30h8M29 38h8M43 38h8" />
      <Lock x={115} y={20} className="text-brand-500" />
      <Lock x={195} y={24} className="text-brand-500" />
    </Svg>
  )
}

/* Two keys on one phone (✗) against one key in each of three places (✓). */
function KeysApart() {
  return (
    <Svg h={92}>
      <Phone x={30} y={6} w={30} h={44} />
      <Key x={19} y={58} className="text-brand-500" />
      <Key x={47} y={58} className="text-brand-500" />
      <Cross x={41} y={78} />
      <path d="M96 6v80" strokeDasharray="2 4" className="text-line" />
      <Phone x={120} y={10} />
      <path d="M152 10h34v24h-34zM148 38h42M200 16h32v22h-32zM200 16l16 12 16-12" />
      <Key x={118} y={58} className="text-brand-500" />
      <Key x={157} y={58} className="text-brand-500" />
      <Key x={204} y={58} className="text-brand-500" />
      <Check x={164} y={78} />
    </Svg>
  )
}

/* The offline round trip: an online wallet (left) hands an unsigned transaction to Fountain on an
   offline device (right), and the signed one comes back. Below, the three ways to carry it. */
function RoundTrip() {
  return (
    <Svg h={100}>
      <path d="M8 26h50v34H8zM33 60v6M27 66h12M25 18a11 11 0 0 1 16 0M29 21a5 5 0 0 1 8 0" />
      <Phone x={192} y={20} w={28} h={48} className="text-ink" />
      <path d="M198 12a11 11 0 0 1 16 0M202 15a5 5 0 0 1 8 0" />
      <path d="M197 5l18 14" className="text-red-600 dark:text-red-400" />
      <path d="M66 36h116M176 32l6 4-6 4M182 64H66M72 60l-6 4 6 4" className="text-line" />
      <g className="hd-go text-ink">
        <Doc x={70} y={27} />
      </g>
      <g className="hd-back text-brand-500">
        <Doc x={156} y={55} />
        <path d="M159 66l2.5 2.5 5-6" />
      </g>
      <path d="M94 82h12v14H94zM97 82v-2h6v2M119 80h9l5 5v11h-14zM144 82h13v13h-13zM146 84h3v3h-3zM152 84h3v3h-3zM146 90h3v3h-3z" />
    </Svg>
  )
}

/* A transfer split into four QR frames: 1, 2 and 4 captured (✓), 3 still missing. */
function QrFrames() {
  return (
    <Svg h={74}>
      {[18, 76, 192].map((x) => (
        <g key={x} transform={at(x, 6)}>
          <rect width="36" height="36" />
          <path d="M4 4h8v8H4zM24 4h8v8h-8zM4 24h8v8H4zM17 6v4M17 17h3v3h-3zM24 24h3v3h-3zM29 29h3v3h-3z" />
        </g>
      ))}
      <rect x="134" y="6" width="36" height="36" strokeDasharray="4 3" className="hd-pulse text-brand-500" />
      {[36, 94, 210].map((cx, i) => (
        <g key={cx}>
          <Check x={cx - 13} y={54} />
          <T x={cx + 6} y={63} className="text-ink-muted">{i === 2 ? 4 : i + 1}</T>
        </g>
      ))}
      <T x={152} y={63} className="hd-pulse text-brand-500">3</T>
    </Svg>
  )
}

/* Two addresses, one from each device, compared four characters at a time: a frame steps along
   the matching groups. Still frame: the frame on the first group. */
function AddressMatch() {
  const bars = [18, 11, 21, 14, 19, 9]
  return (
    <Svg h={96}>
      <path d="M6 12h22v15H6zM17 27v4M13 31h8" />
      <Phone x={10} y={48} w={14} h={24} />
      {bars.map((w, i) => {
        const x = 40 + i * 33
        return (
          <g key={x}>
            <rect x={x} y="14" width="29" height="12" className="text-line" />
            <rect x={x} y="54" width="29" height="12" className="text-line" />
            <path d={`M${x + 4} 20h${w}M${x + 4} 60h${w}`} strokeWidth={3} className="text-ink" />
          </g>
        )
      })}
      <rect x="37" y="8" width="35" height="64" strokeWidth={2} className="hd-scan text-brand-500" />
      <Check x={127} y={80} />
    </Svg>
  )
}

/* What it takes without us: key + key + the descriptor = the vault opens and funds can move. */
function RecoveryKit() {
  return (
    <Svg h={74}>
      <Key x={4} y={26} className="text-brand-500" />
      <Key x={46} y={26} className="text-brand-500" />
      <path d="M33 32h8M37 28v8M75 32h8M79 28v8M118 29h8M118 35h8" />
      <g className="text-ink">
        <path d="M92 18h14l6 6v20H92zM106 18v6h6M96 30h12M96 35h12M96 40h8" />
        <rect x="134" y="15" width="34" height="34" />
        <circle cx="151" cy="32" r="7" />
      </g>
      <path d="M172 32h36" className="hd-flow text-brand-500" strokeDasharray="4 4" />
      <path d="M202 28l6 4-6 4" className="text-brand-500" />
      <circle cx="222" cy="32" r="9" className="text-brand-500" />
      <circle cx="222" cy="32" r="4.5" className="text-brand-500" />
      <T x={37} y={62}>2/3</T>
    </Svg>
  )
}

/* Three keyholders' screens show the vault's checksum: two agree (✓), one differs (✗). */
function ChecksumCompare() {
  return (
    <Svg h={84}>
      {[8, 88, 168].map((x, i) => (
        <g key={x}>
          <rect x={x} y="8" width="64" height="34" />
          <path d={`M${x + 26} 48h12`} />
          <T x={x + 11} y={30} className="text-ink-muted">#</T>
          {[0, 1, 2, 3].map((j) => (
            <rect key={j} x={x + 21 + j * 10} y="20" width="7" height="10" fill="currentColor" stroke="none"
              className={i === 2 && j === 2 ? 'text-red-600 dark:text-red-400' : 'text-ink'} />
          ))}
          {i < 2 ? <Check x={x + 27} y={60} /> : <Cross x={x + 28} y={60} />}
        </g>
      ))}
    </Svg>
  )
}

const DIAGRAMS: Record<HelpDiagramId, ComponentType> = {
  anyTwoOfThree: AnyTwoOfThree,
  backupArtifacts: BackupArtifacts,
  keysApart: KeysApart,
  roundTrip: RoundTrip,
  qrFrames: QrFrames,
  addressMatch: AddressMatch,
  recoveryKit: RecoveryKit,
  checksumCompare: ChecksumCompare,
}

/** The framed drawing for one Help leaf. Decorative to assistive tech: the text says it all. */
export function HelpDiagram({ id }: { id: HelpDiagramId }) {
  const Drawing = DIAGRAMS[id]
  return (
    <div className="hd-anim mx-auto w-full max-w-sm border border-line bg-surface p-3 text-ink-muted">
      <Drawing />
    </div>
  )
}
