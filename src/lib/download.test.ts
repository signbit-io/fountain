import { describe, it, expect } from 'vitest'
import { safeFileSlug, defaultKeyExportFilename, planKeyExports, FILE_PREFIX } from './download'

/*
  Only the PURE filename helpers are tested here — `saveTextFile`/`readTextFile` go through the
  Tauri dialog/fs plugins and have no Node-side equivalent to exercise (same split as qr.ts:
  the format logic is pure and tested, the platform call is verified by hand).

  The naming contract these pin: every file the app writes starts with `signbit-`, so ONE
  machine-wide search for "signbit" finds a user's keystore, backups, and exported keys. This
  is a recovery property, not cosmetics — worth a test that fails loudly if a prefix is dropped.
*/

describe('safeFileSlug', () => {
  it('lowercases and collapses unsafe runs into single dashes', () => {
    expect(safeFileSlug('My Cold Key')).toBe('my-cold-key')
    expect(safeFileSlug('key #2 (backup!)')).toBe('key-2-backup')
  })

  it('strips leading/trailing dashes so a prefix never doubles up', () => {
    // Guards defaultKeyExportFilename: a label like "!key" must not yield "signbit-key--key".
    expect(safeFileSlug('!!key!!')).toBe('key')
    expect(safeFileSlug('  spaced  ')).toBe('spaced')
  })

  it('falls back when a label slugs down to nothing', () => {
    expect(safeFileSlug('!!!')).toBe('key')
    expect(safeFileSlug('', 'companion')).toBe('companion')
    expect(safeFileSlug('...', 'companion')).toBe('companion')
  })
})

describe('defaultKeyExportFilename', () => {
  it('carries the signbit prefix, the label, and the fingerprint', () => {
    expect(defaultKeyExportFilename('My Cold Key', '73c5da0a')).toBe('signbit-key-my-cold-key-73c5da0a.json')
  })

  it('is findable by searching a drive for "signbit"', () => {
    const name = defaultKeyExportFilename('laptop', '6e034476')
    expect(name.startsWith(`${FILE_PREFIX}-`)).toBe(true)
    expect(name.endsWith('.json')).toBe(true)
  })

  it('distinguishes two keys sharing a label by fingerprint', () => {
    const a = defaultKeyExportFilename('backup', '73c5da0a')
    const b = defaultKeyExportFilename('backup', '6e034476')
    expect(a).not.toBe(b)
  })

  it('stays clean for an unlabeled key (no "key-key" stutter, no double dash)', () => {
    const name = defaultKeyExportFilename('', '73c5da0a')
    expect(name).toBe('signbit-key-companion-73c5da0a.json')
    expect(name).not.toContain('--')
  })
})

describe('planKeyExports', () => {
  const k = (label: string, masterFingerprint: string, json = '{}') => ({ label, masterFingerprint, json })

  it('gives every key its own file, named label + fingerprint', () => {
    const plan = planKeyExports([k('Laptop', '73c5da0a'), k('Cold', '6e034476')])
    expect(plan.map((p) => p.filename)).toEqual([
      'signbit-key-laptop-73c5da0a.json',
      'signbit-key-cold-6e034476.json',
    ])
  })

  it('exports N files for N keys — the whole point of the bulk path', () => {
    const many = Array.from({ length: 15 }, (_, i) => k(`key ${i}`, String(i).padStart(8, '0')))
    expect(planKeyExports(many)).toHaveLength(15)
  })

  it('carries each key\u2019s own json through untouched', () => {
    const plan = planKeyExports([k('a', '00000001', '{"xpub":"A"}'), k('b', '00000002', '{"xpub":"B"}')])
    expect(plan.map((p) => p.text)).toEqual(['{"xpub":"A"}', '{"xpub":"B"}'])
  })

  it('suffixes a colliding name rather than letting one file overwrite another', () => {
    // Same label AND fingerprint. importKey blocks duplicate seeds so this should be
    // unreachable — but a silently-dropped key is the failure this guards, so it is pinned.
    const plan = planKeyExports([k('backup', '73c5da0a'), k('backup', '73c5da0a'), k('backup', '73c5da0a')])
    expect(plan.map((p) => p.filename)).toEqual([
      'signbit-key-backup-73c5da0a.json',
      'signbit-key-backup-73c5da0a-2.json',
      'signbit-key-backup-73c5da0a-3.json',
    ])
    expect(new Set(plan.map((p) => p.filename)).size).toBe(3)
  })

  it('keeps the .json extension last when it suffixes', () => {
    // A name ending ".json.2" stops being a JSON file to every picker that reads the extension.
    const plan = planKeyExports([k('x', '00000001'), k('x', '00000001')])
    expect(plan[1].filename.endsWith('.json')).toBe(true)
  })

  it('still yields a distinct file per key when two share a label only', () => {
    const plan = planKeyExports([k('backup', '73c5da0a'), k('backup', '6e034476')])
    expect(new Set(plan.map((p) => p.filename)).size).toBe(2)
  })
})
