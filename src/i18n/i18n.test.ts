import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import en from './locales/en.json'
import fr from './locales/fr.json'
import es from './locales/es.json'
import de from './locales/de.json'

/** Recursively collect dotted key paths from a nested object. */
function keyPaths(obj: unknown, prefix = ''): string[] {
  if (obj && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      keyPaths(v, prefix ? `${prefix}.${k}` : k),
    )
  }
  return [prefix]
}

const enKeys = keyPaths(en).sort()
// en.json is the SOURCE OF TRUTH. Other locales MAY lag behind (missing keys fall
// back to English at runtime — see i18n/index.tsx), so we do NOT fail on missing
// keys. We DO fail on EXTRA/stale keys (a key not in en means a typo or leftover).
// Untranslated coverage is reported (non-failing) — run `npm run i18n:report` for detail.
const otherLocales: Record<string, unknown> = { fr, es, de }

describe('i18n locale parity', () => {
  for (const [name, dict] of Object.entries(otherLocales)) {
    const keys = keyPaths(dict).sort()

    // HARD: no locale may contain a key that en doesn't (catches typos/stale keys).
    it(`${name} has no keys that en lacks`, () => {
      expect(keys.filter((k) => !enKeys.includes(k))).toEqual([])
    })

    // SOFT: report untranslated keys (missing vs en) without failing — they fall
    // back to English. Keeps visibility without forcing per-feature translation.
    it(`${name} translation coverage (report only)`, () => {
      const missing = enKeys.filter((k) => !keys.includes(k))
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.info(`[i18n] ${name}: ${missing.length}/${enKeys.length} keys untranslated (fall back to English)`)
      }
      expect(true).toBe(true)
    })
  }
})

// Every LITERAL t('a.b') key referenced in source must exist in en.json — otherwise
// t() renders the raw key string on screen. Dynamic keys (t(`x.${y}`) / a variable,
// e.g. the help.* tree) are skipped — they can't be resolved statically. Mirrors
// `npm run i18n:check`; kept here so it's enforced in the same CI run as parity.
describe('i18n t() keys resolve in en', () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const enSet = new Set(enKeys)

  function srcFiles(d: string, out: string[] = []): string[] {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      const p = join(d, e.name)
      if (e.isDirectory()) srcFiles(p, out)
      else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p)
    }
    return out
  }

  /*
    STRUCTURE MUST NOT LEAK INTO COPY. `lib/help-topics.ts` owns the topic tree — including
    every `crossRefs` array — and `HelpScreen` reads them from THERE, never through `t()`.

    Six `crossRefs` entries had nonetheless been duplicated into the locale files, where they
    were dead weight with a trap attached: they showed up in the untranslated report as if they
    were prose, and translating one (`'vaults.enrolling'` → `'coffres.inscription'`) would
    produce a topic id that resolves to nothing. Locales hold TEXT A USER READS; an identifier
    is not that.
  */
  it('holds no structural data — crossRefs belong to help-topics.ts, not the locales', () => {
    const offenders = Object.entries({ en, ...otherLocales }).flatMap(([name, dict]) =>
      keyPaths(dict)
        .filter((k) => k.includes('.crossRefs'))
        .map((k) => `${name}: ${k}`),
    )
    expect(offenders).toEqual([])
  })

  it('has no unresolved literal keys', () => {
    const re = /\bt\(\s*(['"])([a-zA-Z0-9_.]+)\1/g
    const misses: string[] = []
    for (const file of srcFiles(srcRoot)) {
      // Skip the i18n implementation itself — its doc comments show example t() calls.
      if (/i18n[\\/]index\.tsx?$/.test(file)) continue
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        if (!enSet.has(m[2])) misses.push(`${m[2]} (${file.replace(srcRoot, 'src')})`)
      }
    }
    expect(misses).toEqual([])
  })
})

/*
  COPY THE DRIFT CHECK COULD NOT SEE (2026-10-04 sweep). `i18n:check` compares a translation
  with the English it was stamped against; these were stamped as current while already wrong,
  so only an assertion about what they SAY can catch them.
*/
describe('locale copy that stayed wrong while counting as translated', () => {
  const valueAt = (dict: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], dict)

  it('German addresses the reader as Sie throughout, never du', () => {
    // The house register is de = Sie (es = tú, fr = vous). Pronouns, plus the du-imperatives
    // this file actually carried; a Sie imperative is always followed by "Sie".
    const informal = /\b(du|dich|dir|dein|deine|deinen|deinem|deiner|deines)\b/i
    const duImperative =
      /(^|[^\p{L}])(Gib|Schreib|Achte|Füge|füge|Kopiere|Bewahre|Vergleiche|Scanne|scanne|Tippe|tippe|Richte|Wähle|Notiere|Erstelle|Betrachte)(?![\p{L}])(?!\s+Sie(?![\p{L}]))/u
    const offenders = keyPaths(de).filter((k) => {
      const v = valueAt(de, k)
      return typeof v === 'string' && (informal.test(v) || duImperative.test(v))
    })
    expect(offenders).toEqual([])
  })

  it('the Message tab no longer calls every message a policy change (fr/es/de)', () => {
    // The tab signs ANY message (an inheritance claim moves coins); en was reworded long ago.
    for (const [name, dict] of Object.entries(otherLocales)) {
      for (const key of ['sign.approvalLabel', 'sign.resultApproval']) {
        expect(valueAt(dict, key), `${name} ${key}`).not.toMatch(/politique|política|Richtlinie/i)
      }
      expect(valueAt(dict, 'sign.approvalPlaceholder'), `${name} placeholder`).toContain('SIGNBIT-VAULT-IMPORT')
    }
  })

  it('no locale uses an em dash in its copy (a value that is only "—" is a placeholder)', () => {
    // House rule: no em dashes in user-facing copy. A lone "—" stands in for "no value".
    for (const [name, dict] of Object.entries({ en, ...otherLocales })) {
      const offenders = keyPaths(dict).filter((k) => {
        const v = valueAt(dict, k)
        return typeof v === 'string' && v.includes('—') && v.trim() !== '—'
      })
      expect(offenders, name).toEqual([])
    }
  })
})
