import { describe, expect, it } from 'vitest'
import { encodeToFrames, parseFrame, FrameCollector, decodeFrames, frameToSvg } from './qr'

describe('encodeToFrames / parseFrame', () => {
  it('encodes a short payload as a single frame', () => {
    const frames = encodeToFrames('hello world')
    expect(frames).toHaveLength(1)
    const parsed = parseFrame(frames[0])
    expect(parsed.status).toBe('ok')
    if (parsed.status === 'ok') {
      expect(parsed.frame.i).toBe(0)
      expect(parsed.frame.n).toBe(1)
      expect(parsed.frame.d).toBe('hello world')
    }
  })

  it('splits a long payload into multiple frames sharing one id', () => {
    const payload = 'x'.repeat(2500)
    const frames = encodeToFrames(payload, 800)
    expect(frames.length).toBe(4) // 2500 / 800 -> 4 chunks
    const parsedIds = frames.map((f) => {
      const p = parseFrame(f)
      if (p.status !== 'ok') throw new Error('expected ok')
      return p.frame.id
    })
    expect(new Set(parsedIds).size).toBe(1) // all frames share the same id
  })

  it('rejects an empty payload', () => {
    expect(() => encodeToFrames('')).toThrow()
  })

  it('parseFrame reports invalid for non-frame data (e.g. a foreign QR payload)', () => {
    expect(parseFrame('not json').status).toBe('invalid')
    expect(parseFrame(JSON.stringify({ some: 'thing' })).status).toBe('invalid')
    expect(parseFrame(JSON.stringify({ v: 2, id: 'ab', i: 0, n: 1, d: 'x' })).status).toBe('invalid') // wrong version
    expect(parseFrame(JSON.stringify({ v: 1, id: 'ab', i: 1, n: 1, d: 'x' })).status).toBe('invalid') // i out of range
  })
})

/*
  A scanned frame is the one input here that arrives from OUTSIDE the air gap — whatever is
  physically held in front of the camera. The payload it carries is not trusted (the platform
  re-derives and validates it), but the ENVELOPE is acted on locally and immediately, before
  any of that: `n` decides how many indices the collector walks and how many ticks render.
  These pin the envelope's own bounds, which no server check covers.
*/
describe('parseFrame hostile envelopes (a QR is attacker-supplied input)', () => {
  it('rejects an absurd frame count, which would otherwise hang the scanner on one glance', () => {
    // The attack: `missing()` walks 0..n-1 on EVERY scanned frame and the progress strip
    // renders an element per frame, so a believed `n` of 1e9 is an unbounded loop and a
    // billion-element array — the tab dies with the camera still live.
    expect(parseFrame(JSON.stringify({ v: 1, id: 'ab', i: 0, n: 1e9, d: 'x' })).status).toBe('invalid')
    expect(parseFrame(JSON.stringify({ v: 1, id: 'ab', i: 0, n: 513, d: 'x' })).status).toBe('invalid')
  })

  it('rejects a count JSON can express but JSON.stringify cannot produce', () => {
    // Written as RAW TEXT on purpose. A QR carries bytes an attacker chose by hand, not the
    // output of JSON.stringify — which would have flattened these to `null` and made the test
    // vacuous. `1e999` parses to Infinity, and `0 < Infinity` passes a bare range check while
    // making every 0..n-1 loop unbounded.
    expect(parseFrame('{"v":1,"id":"ab","i":0,"n":1e999,"d":"x"}').status).toBe('invalid')
    expect(parseFrame('{"v":1,"id":"ab","i":0,"n":1e400,"d":"x"}').status).toBe('invalid')
    // And a count beyond safe-integer range, where arithmetic silently stops being exact.
    expect(parseFrame('{"v":1,"id":"ab","i":0,"n":9007199254740993,"d":"x"}').status).toBe('invalid')
  })

  it('rejects fractional indices, which land under a key nothing reads back', () => {
    // `i: 0.5` satisfies `>= 0 && < n`, then stores under a Map key `finish()` never looks up.
    expect(parseFrame(JSON.stringify({ v: 1, id: 'ab', i: 0.5, n: 2, d: 'x' })).status).toBe('invalid')
  })

  it('rejects a zero or negative frame count', () => {
    expect(parseFrame(JSON.stringify({ v: 1, id: 'ab', i: 0, n: 0, d: 'x' })).status).toBe('invalid')
    expect(parseFrame(JSON.stringify({ v: 1, id: 'ab', i: -1, n: -1, d: 'x' })).status).toBe('invalid')
  })

  it('still accepts a legitimately large multi-frame payload (the bound is not in the way)', () => {
    // A 15-cosigner PSBT is the biggest real payload; it must stay comfortably under the cap.
    const frames = encodeToFrames('a'.repeat(500 * 60))
    expect(frames.length).toBe(60)
    for (const f of frames) expect(parseFrame(f).status).toBe('ok')
  })
})

describe('FrameCollector completeness is index COVERAGE, not a count', () => {
  it('is not complete while an index is outstanding, however many frames were stored', () => {
    // Guards the invariant directly: isComplete must agree with what finish() can actually
    // reassemble, rather than trusting that every stored key was a distinct in-range integer.
    const collector = new FrameCollector()
    const frames = encodeToFrames('a'.repeat(1200)) // 3 frames
    for (const idx of [0, 0, 1]) {
      const parsed = parseFrame(frames[idx])
      if (parsed.status !== 'ok') throw new Error('fixture should parse')
      collector.add(parsed.frame)
    }
    expect(collector.isComplete).toBe(false)
    expect(collector.missing()).toEqual([2])
    expect(() => collector.finish()).toThrow()
  })

  it('never reports complete without every frame, so finish() and isComplete cannot disagree', () => {
    const collector = new FrameCollector()
    const frames = encodeToFrames('a'.repeat(1200))
    for (const f of frames) {
      const parsed = parseFrame(f)
      if (parsed.status !== 'ok') throw new Error('fixture should parse')
      collector.add(parsed.frame)
      // At every step the two answers agree.
      if (collector.isComplete) expect(() => collector.finish()).not.toThrow()
      else expect(() => collector.finish()).toThrow()
    }
    expect(collector.isComplete).toBe(true)
  })
})

describe('chunk sizing (tuned on real hardware)', () => {
  /*
    A real 2-of-3 testnet PSBT is ~1480 chars. At the original CHUNK_SIZE of 800 that produced
    2 frames, but each was a QR version ~25 (a 117x117 grid) — dense enough to be genuinely
    fiddly to capture on a phone, which is what on-device testing surfaced.

    A higher QR version packs more modules into the same physical area, so each module gets
    fewer camera pixels. Since frames are static and stepped through at the user's own pace,
    an extra frame costs one tap while an unscannable frame costs the whole transfer.

    This pins the property that matters — a typical PSBT splits into enough frames to stay in
    comfortable QR-version territory — without asserting an exact chunk constant.
  */
  const TYPICAL_PSBT_CHARS = 1480

  it('splits a typical PSBT into enough frames to keep each one scannable', () => {
    const payload = 'x'.repeat(TYPICAL_PSBT_CHARS)
    const frames = encodeToFrames(payload)
    expect(frames.length).toBeGreaterThanOrEqual(3)

    // Every frame (envelope included) must stay well under the ~1000-char mark where QR
    // versions climb past ~25 and phone cameras start to struggle.
    for (const f of frames) expect(f.length).toBeLessThan(700)
  })

  it('still round-trips at the default chunk size', () => {
    const payload = 'a'.repeat(TYPICAL_PSBT_CHARS)
    expect(decodeFrames(encodeToFrames(payload))).toBe(payload)
  })
})

describe('FrameCollector / decodeFrames', () => {
  it('reassembles frames scanned in order', () => {
    const payload = 'sensitive-psbt-base64-blob'.repeat(50)
    const frames = encodeToFrames(payload, 100)
    expect(frames.length).toBeGreaterThan(1)
    expect(decodeFrames(frames)).toBe(payload)
  })

  it('reassembles frames scanned OUT of order (camera scans in whatever order)', () => {
    const payload = 'out-of-order-payload-data'.repeat(50)
    const frames = encodeToFrames(payload, 90)
    const shuffled = [...frames].reverse()
    expect(decodeFrames(shuffled)).toBe(payload)
  })

  /*
    `missing()` exists because a bare "1 of 2" count told the user something was outstanding
    but not WHICH — so on a real scan they re-scanned codes they already held, hunting for the
    gap. The scan UI renders a tick per frame from this.
  */
  it('reports WHICH frame indices are still outstanding', () => {
    const payload = 'which-frames'.repeat(100)
    const frames = encodeToFrames(payload, 100)
    expect(frames.length).toBeGreaterThan(3)
    const collector = new FrameCollector()

    const addByIndex = (i: number) => {
      const parsed = parseFrame(frames[i])
      if (parsed.status !== 'ok') throw new Error('expected ok')
      collector.add(parsed.frame)
    }

    // Scan out of order, deliberately skipping index 1.
    addByIndex(2)
    addByIndex(0)

    expect(collector.has(0)).toBe(true)
    expect(collector.has(1)).toBe(false)
    expect(collector.has(2)).toBe(true)
    // Ascending, 0-based; the UI adds 1 for display.
    expect(collector.missing()).toEqual(expect.arrayContaining([1]))
    expect(collector.missing()).not.toContain(0)
    expect(collector.missing()[0]).toBe(1) // sorted ascending

    // Fill in every remaining frame → nothing outstanding.
    for (let i = 0; i < frames.length; i++) addByIndex(i)
    expect(collector.missing()).toEqual([])
    expect(collector.isComplete).toBe(true)
    expect(collector.finish()).toBe(payload)
  })

  it('reports nothing missing before any frame is seen (total unknown)', () => {
    expect(new FrameCollector().missing()).toEqual([])
  })

  it('tolerates duplicate scans of the same frame', () => {
    const payload = 'dup-test'.repeat(200)
    const frames = encodeToFrames(payload, 100)
    const collector = new FrameCollector()
    for (const f of frames) {
      const parsed = parseFrame(f)
      if (parsed.status !== 'ok') throw new Error('expected ok')
      collector.add(parsed.frame)
      collector.add(parsed.frame) // scan it twice
    }
    expect(collector.isComplete).toBe(true)
    expect(collector.finish()).toBe(payload)
  })

  it('tracks progress (have/total) as frames arrive', () => {
    const payload = 'progress-test'.repeat(100)
    const frames = encodeToFrames(payload, 100)
    const collector = new FrameCollector()
    expect(collector.progress()).toEqual({ have: 0, total: 0 })
    for (const [idx, f] of frames.entries()) {
      const parsed = parseFrame(f)
      if (parsed.status !== 'ok') throw new Error('expected ok')
      collector.add(parsed.frame)
      expect(collector.progress()).toEqual({ have: idx + 1, total: frames.length })
    }
    expect(collector.isComplete).toBe(true)
  })

  it('rejects frames from a different payload sequence (mismatched id)', () => {
    const framesA = encodeToFrames('a'.repeat(2000), 100)
    const framesB = encodeToFrames('b'.repeat(2000), 100)
    const collector = new FrameCollector()
    const firstA = parseFrame(framesA[0])
    const firstB = parseFrame(framesB[1])
    if (firstA.status !== 'ok' || firstB.status !== 'ok') throw new Error('expected ok')
    expect(collector.add(firstA.frame)).toBe('ok')
    expect(collector.add(firstB.frame)).toBe('mismatch')
  })

  it('finish() throws if frames are still missing', () => {
    const frames = encodeToFrames('missing-frame-test'.repeat(100), 100)
    const collector = new FrameCollector()
    const parsed = parseFrame(frames[0])
    if (parsed.status !== 'ok') throw new Error('expected ok')
    collector.add(parsed.frame)
    expect(() => collector.finish()).toThrow()
  })

  it('decodeFrames throws on garbage input', () => {
    expect(() => decodeFrames(['not a frame'])).toThrow()
  })

  it('reset() clears collector state', () => {
    const frames = encodeToFrames('reset-test'.repeat(100), 100)
    const collector = new FrameCollector()
    const parsed = parseFrame(frames[0])
    if (parsed.status !== 'ok') throw new Error('expected ok')
    collector.add(parsed.frame)
    collector.reset()
    expect(collector.progress()).toEqual({ have: 0, total: 0 })
    expect(collector.isComplete).toBe(false)
  })
})

describe('frameToSvg', () => {
  it('renders a scannable SVG string for a frame', () => {
    const frames = encodeToFrames('svg-render-test')
    const svg = frameToSvg(frames[0])
    expect(svg).toContain('<svg')
    expect(svg.length).toBeGreaterThan(100)
  })

  it('is scalable — the outer <svg> has no fixed pixel width/height, so it fills its CSS container (mobile-safe)', () => {
    const frames = encodeToFrames('scalable-test')
    const svg = frameToSvg(frames[0])
    const svgTag = svg.match(/^<svg[^>]*>/)?.[0] ?? ''
    expect(svgTag).not.toMatch(/\bwidth="\d/)
    expect(svgTag).not.toMatch(/\bheight="\d/)
    expect(svgTag).toMatch(/viewBox="0 0 \d+ \d+"/)
  })

  it('round-trips PSBT-sized data through encode -> svg -> (assumed scan) -> decode', () => {
    // Simulates the real flow's shape without a camera: a base64-ish multi-KB "PSBT" is
    // chunked, each chunk would be shown as its own QR (frameToSvg), and scanning it back
    // (represented here by re-parsing the same frame strings) reassembles the original.
    const fakePsbtBase64 = 'cHNidP8BAH0CAAAAAd'.repeat(300) // ~5.4KB, forces multiple frames
    const frames = encodeToFrames(fakePsbtBase64)
    expect(frames.length).toBeGreaterThan(1)
    for (const f of frames) expect(frameToSvg(f)).toContain('<svg')
    expect(decodeFrames(frames)).toBe(fakePsbtBase64)
  })
})
