import qrcode from 'qrcode-generator'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'

/*
  QR transport for PSBT / policy-approval text — the third hand-carried transport alongside
  copy-paste and file (lib/download.ts). Two independent halves:

   - ENCODE/DISPLAY: turn arbitrary text (a base64/hex PSBT or an approval signature block)
     into one or more QR codes to render on screen.
   - DECODE/SCAN: turn one or more scanned QR strings back into the original text.

  Single vs multi-frame: most payloads (an approval signature, a small PSBT) fit in ONE QR.
  A large multisig PSBT can be several KB — too dense for one reliably-scannable code — so it
  splits into multiple STATIC frames the user steps through in order (like a paginated
  slideshow: "1 of 4", tap Next / scan next). This is deliberately NOT a timed animation —
  both sides move at the user's own pace, which is far more robust than a scanner racing a
  fixed frame rate.

  Frame format (our own, deliberately not BC-UR — see the README/notes): a small JSON envelope per
  frame, so decoding needs no external protocol assumptions:
    { v: 1, id: '<8-hex>', i: <0-based index>, n: <total frames>, d: '<chunk of the payload>' }
  `id` is a short digest of the FULL payload (not a security hash — just enough to detect
  frames from two different scans/payloads being mixed together) and is the same across all
  frames of one payload. Frames can be scanned in ANY order and de-duplicated by `i`; decoding
  only requires that all `n` distinct indices for one `id` have been seen.

  ⚠️ THIS FILE IS NOW A CROSS-REPO CONTRACT, not just this app talking to itself. The SignBit
  platform displays a spend's PSBT as these frames for this app to scan, so it holds a COPY of
  the framing logic below. **This file is the ORIGIN** — fix bugs here, then re-copy there. A
  drift guard on the platform side hashes both bodies and fails CI on divergence; without it, a
  change here would silently stop PSBTs reassembling on the phone, with no error pointing at the
  cause. Two things are deliberately NOT shared:
  `frameToSvg` (the platform renders with its own `qrcode.react`) and `payloadId` (the
  platform has no `@noble/hashes`; an id is only ever matched against frames from the same
  sender, so the algorithms need not agree).
*/

const FRAME_VERSION = 1

/*
  Per-frame chunk size — the trade between FEWER frames and EASIER-to-scan frames.

  ⚠️ Tuned against a REAL 2-of-3 testnet PSBT (1480 chars) on real hardware, after 800 proved
  awkward to scan on a phone:

     chunk | frames | QR version
       800 |      2 | 25   ← was: a 117x117 grid, dense and fiddly to capture
       500 |      3 | 20   ← now: noticeably easier, one extra frame
       350 |      5 | 15

  A higher QR version packs more modules into the same physical area, so each module gets
  fewer camera pixels — past roughly version 20 a phone has to be held closer and steadier,
  and a low-resolution webcam struggles entirely. Since frames are STATIC and stepped through
  at the user's own pace (not a timed animation), an extra frame costs one tap, while a frame
  that won't scan costs the whole transfer. Cheap trade, so err toward more frames.

  ⚠️ This value is part of the wire format in practice: both endpoints must chunk compatibly
  for a payload to reassemble. Changing it is safe in one direction only — a NEW sender's
  frames still decode on an OLD receiver (the envelope carries `n` and each frame's index, so
  nothing assumes a fixed size), but both sides should stay in step to avoid surprises.
*/
const CHUNK_SIZE = 500

export type QrFrame = {
  v: number
  id: string
  i: number
  n: number
  d: string
}

/** Short, non-cryptographic id for grouping a payload's frames — first 8 hex chars of sha256. */
function payloadId(payload: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(payload))).slice(0, 8)
}

/**
 * Split text into one or more QR frame payloads (JSON strings, one per code to render).
 * A payload short enough for one frame yields a single-element array.
 */
export function encodeToFrames(payload: string, chunkSize = CHUNK_SIZE): string[] {
  if (payload.length === 0) throw new Error('Nothing to encode')
  const id = payloadId(payload)
  const chunks: string[] = []
  for (let start = 0; start < payload.length; start += chunkSize) {
    chunks.push(payload.slice(start, start + chunkSize))
  }
  const n = chunks.length
  return chunks.map((d, i): string => JSON.stringify({ v: FRAME_VERSION, id, i, n, d } satisfies QrFrame))
}

/**
 * Render a single frame string to an SVG string (for display in an <img>/inline).
 * `scalable: true` drops the library's default fixed pixel width/height in favor of the
 * viewBox alone, so the SVG actually fills/scales with its CSS container — without it, the
 * QR renders at a hardcoded pixel size regardless of the wrapper (breaks on narrow phone
 * screens where it wouldn't otherwise shrink to fit).
 */
export function frameToSvg(frameText: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(frameText)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

export type FrameParseResult =
  | { status: 'ok'; frame: QrFrame }
  | { status: 'invalid' } // not a recognized frame (e.g. a QR from something else entirely)

/*
  Upper bound on `n`, the frame count a single scanned QR is allowed to CLAIM.

  ⚠️ SECURITY, not ergonomics. `n` arrives from a QR code — i.e. from whatever is held in front
  of the camera — and is believed BEFORE any payload exists to sanity-check it against. The UI
  then allocates per claimed frame: the collector walks 0..n-1 to list missing indices, and the
  progress strip renders one tick element per frame. A hand-drawn code claiming `n: 1e9` (or
  `Infinity`) therefore turns one glance at the camera into an unbounded loop and a
  billion-element array — the scanner tab dies with the camera still live, before the user has
  agreed to anything. That is reachable by a stranger holding up a piece of paper.

  512 is far above any real payload (the largest thing sent is a 15-cosigner PSBT — tens of
  frames at CHUNK_SIZE) and far below anything that costs a frame of animation to reject.
*/
const MAX_FRAMES = 512

/** Parse one scanned QR string as a frame. Never throws — unrecognized data is 'invalid'. */
export function parseFrame(scanned: string): FrameParseResult {
  try {
    const obj = JSON.parse(scanned)
    if (
      obj &&
      typeof obj === 'object' &&
      obj.v === FRAME_VERSION &&
      typeof obj.id === 'string' &&
      typeof obj.d === 'string' &&
      // Integer-checked, not merely `typeof number`: a fractional index (`i: 0.5`) passes a
      // bare range test, then lands in the collector under a key nothing ever reads back,
      // and NaN/Infinity defeat range tests entirely. Require honest array indices.
      Number.isInteger(obj.i) &&
      Number.isInteger(obj.n) &&
      obj.n >= 1 &&
      obj.n <= MAX_FRAMES &&
      obj.i >= 0 &&
      obj.i < obj.n
    ) {
      return { status: 'ok', frame: obj as QrFrame }
    }
    return { status: 'invalid' }
  } catch {
    return { status: 'invalid' }
  }
}

/**
 * Accumulates scanned frames across possibly-out-of-order scans of one payload's QR sequence.
 * Rejects frames whose `id` doesn't match the first frame seen (a different payload/scan
 * session), AND frames that contradict an index already captured, so scanning the wrong QR
 * mid-sequence fails loudly instead of corrupting the result.
 */
export class FrameCollector {
  private id: string | null = null
  private total = 0
  private byIndex = new Map<number, string>()

  /** Add a scanned frame. Returns 'mismatch' if it belongs to a different payload's sequence. */
  add(frame: QrFrame): 'ok' | 'mismatch' {
    if (this.id === null) {
      this.id = frame.id
      this.total = frame.n
    } else if (frame.id !== this.id || frame.n !== this.total) {
      return 'mismatch'
    }
    /*
      A CONFLICTING chunk for an index already held is a mismatch, not an update.

      `id` is an 8-hex grouping tag the SENDER asserts; it is never re-derived from the
      reassembled payload, and the two repos compute it with different algorithms on purpose
      (see the header). So "same id, same n" is something a frame can simply CLAIM. This used
      to `set` unconditionally — last write wins, returning 'ok' — which meant a frame carrying
      the victim's id at an index already captured silently REPLACED that chunk, and the
      scanner cheerfully reported "3 of 3" over a payload nobody sent. Whether that arrives
      from a stranger holding up a printed code or from an ordinary id collision, it is the
      exact "corrupting the result" this class's docstring promises not to do.

      Refusing the CONFLICT rather than verifying a digest is deliberate: it compares the
      sender's frames only against each other, so it needs no cross-repo agreement about how
      `id` is computed. An IDENTICAL re-scan stays 'ok' — sweeping back over a frame already
      captured is the normal way people use the scanner.
    */
    const held = this.byIndex.get(frame.i)
    if (held !== undefined && held !== frame.d) return 'mismatch'
    this.byIndex.set(frame.i, frame.d)
    return 'ok'
  }

  /** How many distinct frames received vs. how many the sequence needs. */
  progress(): { have: number; total: number } {
    return { have: this.byIndex.size, total: this.total }
  }

  /**
   * WHICH frame indices are still outstanding (0-based), ascending.
   *
   * A bare "1 of 2" count tells a user they're missing something but not WHAT — so they end up
   * re-scanning frames they already have, hunting for the one they don't. Naming the missing
   * frames ("still need 2 of 3") turns that into a directed action. Empty once complete.
   */
  missing(): number[] {
    if (this.total === 0) return []
    const out: number[] = []
    for (let i = 0; i < this.total; i++) if (!this.byIndex.has(i)) out.push(i)
    return out
  }

  /** Whether a specific frame index has been captured — for per-frame UI ticks. */
  has(index: number): boolean {
    return this.byIndex.has(index)
  }

  /*
    Completeness is COVERAGE of every index 0..total-1, not a count of stored frames.

    ⚠️ `byIndex.size === total` was the same check only as long as every stored key was a
    distinct in-range integer — which is exactly the property a scanned frame cannot be trusted
    to have. Counting let a set of frames satisfy "complete" without holding the indices
    `finish()` goes on to read, so the size check and the reassembly disagreed about what
    "done" meant. parseFrame now rejects such frames up front; this asks the question the
    consumer actually cares about, so the two agree by construction rather than by a shared
    assumption about the input.
  */
  get isComplete(): boolean {
    return this.total > 0 && this.missing().length === 0
  }

  /** Reassemble the full payload once complete; throws if frames are still missing. */
  finish(): string {
    if (!this.isComplete) throw new Error('Missing frames')
    let out = ''
    for (let i = 0; i < this.total; i++) {
      const chunk = this.byIndex.get(i)
      if (chunk === undefined) throw new Error(`Missing frame ${i + 1} of ${this.total}`)
      out += chunk
    }
    return out
  }

  reset(): void {
    this.id = null
    this.total = 0
    this.byIndex.clear()
  }
}

/** Convenience: decode a complete, in-order set of frame strings straight to the payload. */
export function decodeFrames(frameTexts: string[]): string {
  const collector = new FrameCollector()
  for (const text of frameTexts) {
    const parsed = parseFrame(text)
    if (parsed.status !== 'ok') throw new Error('Not a valid QR frame')
    if (collector.add(parsed.frame) === 'mismatch') throw new Error('Frames belong to different payloads')
  }
  return collector.finish()
}
