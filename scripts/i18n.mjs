/*
  i18n CLI — one tool for every locale operation, built so you (or an LLM) never
  have to open a ~1600-line locale file just to read or change a few keys. en.json
  is the source of truth; fr/es/de (and any future locale) are partial and fall
  back to English at runtime.

  Zero deps. Works unchanged across the SignBit apps that share this layout.
  Adding a new locale = drop `<code>.json` in locales/ — every command picks it up
  automatically (they enumerate the directory, nothing is hard-coded).

  Subcommands:
    check              Assert every LITERAL t('a.b') key in src/ exists in en.json.
                       Skips dynamic keys (t(`x.${y}`) / t(variable)) — can't resolve
                       those statically. Exits 1 on any miss. THIS is the CI guard.
    missing [locale]   Per-locale list of untranslated keys (+ English text), and any
                       stale keys (present in a locale, gone from en). Always exits 0.
    get <glob>         Print just the keys matching a dotted-glob (e.g. "vaults.pend*")
                       across all locales — so you load a handful of keys, not 20k
                       tokens of JSON. Supports * (any run) and ? (one char).
    set <key> --en "…" [--fr "…"] [--de "…"] …
                       Add/update ONE key by dotted path in the given locales, placed
                       deterministically (no hand-editing → no mis-nesting / dupes).
                       en is required when the key is new.
    apply <file|->     Bulk-inject a { "a.b": { fr:"…", … } } map (file path or stdin).
    baseline [locale]  Stamp every EXISTING translation as current against today's en.
                       Run ONCE per repo to adopt drift detection, and never routinely —
                       it ASSERTS the translations are correct, it does not verify them.

  ── DRIFT: the hole this tool had until 2026-08-28 ──────────────────────────
  Coverage asked "does this locale have a value for this key" and `stale` asked "is
  this key gone from en". Neither question is asked of a key whose ENGLISH CHANGED
  while the translations sat still: it is present in all four locales, so it counted
  as 100% translated while fr/es/de kept asserting the OLD claim. On a custody product
  that is the failure that matters — the 2026-08-24 Help audit reworded three ACCURACY
  fixes, and a French reader would have kept the version that overstated what a backup
  recovers.

  The fix: `<locale>.src.json` records, per key, an 8-char hash of the ENGLISH TEXT the
  translation was made against. `set` and `apply` write it automatically. When en later
  changes, the hash no longer matches and the key is reported as DRIFTED — by `missing`,
  and as a FAILURE by `check`, because the house rule is that a reworded en string gets
  its fr/es/de in the SAME change.

  Usage:  node scripts/i18n.mjs <subcommand> [args]
          npm run i18n:check | i18n:get -- "vaults.pend*" | i18n:set -- k --en "…"
*/
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'src', 'i18n', 'locales')
const srcDir = join(root, 'src')

// ---- shared helpers -------------------------------------------------------
const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
const localeFiles = () => readdirSync(dir).filter((f) => f.endsWith('.json'))
const otherFiles = () => localeFiles().filter((f) => f !== 'en.json')

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out[key] = v
  }
  return out
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.')
  let node = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (typeof node[p] !== 'object' || node[p] === null) node[p] = {}
    node = node[p]
  }
  node[parts[parts.length - 1]] = value
}

// Reorder `obj`'s keys to match en's structure so files stay diff-friendly.
function orderLike(reference, obj) {
  if (typeof reference !== 'object' || reference === null) return obj
  const out = {}
  for (const k of Object.keys(reference)) if (k in obj) out[k] = orderLike(reference[k], obj[k])
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k]
  return out
}

function writeLocale(file, data) {
  const en = load('en.json')
  writeFileSync(join(dir, file), JSON.stringify(orderLike(en, data), null, 2) + '\n')
}

// ---- drift fingerprints ---------------------------------------------------
/*
  A translation is "current" if the English it was made against still says the same
  thing. We record a fingerprint of that English rather than a copy of it: the sidecars
  stay small and their diffs stay readable, and the CURRENT en text is always one lookup
  away for whoever retranslates.

  FNV-1a, not a crypto hash - this detects an edit, it does not defend against one. Zero
  deps is a hard constraint of this file (it runs in two repos), and node:crypto would
  work but buys nothing here.
*/
function fingerprint(text) {
  let h = 0x811c9dc5
  const s = String(text)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const srcFile = (locale) => `${locale}.src.json`
const loadSrc = (locale) =>
  existsSync(join(dir, srcFile(locale))) ? JSON.parse(readFileSync(join(dir, srcFile(locale)), 'utf8')) : {}

/*
  Sidecars are FLAT and key-sorted, deliberately. They are machine-written and only ever
  read as "did this one key change", so nesting them like the locale files would add a
  merge-conflict surface for no reader's benefit.
*/
function writeSrc(locale, map) {
  const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]))
  writeFileSync(join(dir, srcFile(locale)), JSON.stringify(sorted, null, 2) + '\n')
}

/**
 * Keys this locale translates whose English has CHANGED since. Excludes keys with no
 * recorded fingerprint: before `baseline` runs, "unknown" is not "drifted", and calling
 * it drift would report every pre-existing translation as broken on day one.
 */
function driftedKeys(locale, enFlat) {
  const loc = flatten(load(`${locale}.json`))
  const src = loadSrc(locale)
  return Object.keys(loc).filter(
    (k) => k in enFlat && k in src && src[k] !== fingerprint(enFlat[k]),
  )
}

/** Keys translated but never fingerprinted - the pre-`baseline` backlog. */
function unstampedKeys(locale, enFlat) {
  const loc = flatten(load(`${locale}.json`))
  const src = loadSrc(locale)
  return Object.keys(loc).filter((k) => k in enFlat && !(k in src))
}

/** Record `keys` in `locale`'s sidecar as current against today's en. */
function stamp(locale, keys, enFlat) {
  const src = loadSrc(locale)
  let n = 0
  for (const k of keys) {
    if (!(k in enFlat)) continue
    const fp = fingerprint(enFlat[k])
    if (src[k] !== fp) n++
    src[k] = fp
  }
  // A key gone from en is `stale` and already reported; drop its fingerprint so the
  // sidecar cannot outlive the locale file it describes.
  for (const k of Object.keys(src)) if (!(k in enFlat)) delete src[k]
  writeSrc(locale, src)
  return n
}

// Recursively list source files (skips node_modules/dist), so `check` needs no glob dep.
function srcFiles(d = srcDir, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = join(d, e.name)
    if (e.isDirectory()) srcFiles(p, out)
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p)
  }
  return out
}

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`)
}

// ---- subcommands ----------------------------------------------------------
function cmdCheck() {
  const en = flatten(load('en.json'))
  // Only LITERAL single-quoted/double-quoted keys: t('a.b') / t("a.b"). A template
  // literal or a variable arg is dynamic — we can't resolve it statically, so skip.
  const re = /\bt\(\s*(['"])([a-zA-Z0-9_.]+)\1/g
  const misses = []
  for (const file of srcFiles()) {
    // Skip the i18n implementation itself — its doc comments contain illustrative
    // t('a.b.c') calls that aren't real keys (the ONE file that legitimately does).
    if (/i18n[\\/]index\.tsx?$/.test(file)) continue
    let text = readFileSync(file, 'utf8')
    // Strip comments so a commented-out or documented t('…') never counts.
    text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    let m
    while ((m = re.exec(text))) {
      const key = m[2]
      if (!(key in en)) misses.push({ file: file.replace(root + '\\', '').replace(root + '/', ''), key })
    }
  }
  /*
    ⚠️ `check` guards TWO different failures, and they are not the same shape.
    A missing key renders as raw text — visibly broken, in every locale, immediately.
    A DRIFTED key renders perfectly: the old translation, asserting the old claim, to
    a reader who has no way to know. That is the more dangerous of the two on a custody
    product, and the reason it is a CI failure rather than a warning is the house rule:
    reword an en string and its fr/es/de land in the SAME change.
  */
  const enAll = flatten(load('en.json'))
  const drift = []
  for (const file of otherFiles()) {
    const locale = file.replace('.json', '')
    for (const key of driftedKeys(locale, enAll)) drift.push({ locale, key })
  }

  if (misses.length === 0 && drift.length === 0) {
    console.log('i18n check: OK — every literal t() key resolves in en.json, no translation drift')
    return 0
  }
  if (drift.length) {
    console.error(
      `i18n check: ${drift.length} DRIFTED translation(s) — the English changed, these did not:${'\n'}`,
    )
    const byKey = new Map()
    for (const { locale, key } of drift) byKey.set(key, [...(byKey.get(key) ?? []), locale])
    for (const [key, locales] of byKey) {
      console.error(`   ✗ ${key}   (${locales.join(', ')})`)
      console.error(`       en is now: ${JSON.stringify(enAll[key])}`)
    }
    console.error(
      `${'\n'}Retranslate them, then re-stamp:  node scripts/i18n.mjs set <key> --fr "…" --es "…" --de "…"`,
    )
    if (misses.length) console.error('')
  }
  if (misses.length === 0) return 1
  console.error(`i18n check: ${misses.length} unresolved key(s) — will render as raw text:\n`)
  for (const { file, key } of misses) console.error(`   ✗ ${key}   (${file})`)
  console.error('\nAdd the key to en.json (e.g. node scripts/i18n.mjs set ' + misses[0].key + ' --en "…").')
  return 1
}

function cmdMissing(only) {
  const en = flatten(load('en.json'))
  const enKeys = Object.keys(en)
  console.log(`en.json: ${enKeys.length} keys (source of truth)\n`)
  for (const file of otherFiles()) {
    if (only && file !== `${only}.json`) continue
    const loc = flatten(load(file))
    const locKeys = new Set(Object.keys(loc))
    const missing = enKeys.filter((k) => !locKeys.has(k))
    const stale = Object.keys(loc).filter((k) => !(k in en))
    const locale = file.replace('.json', '')
    const drifted = driftedKeys(locale, en)
    const unstamped = unstampedKeys(locale, en)

    /*
      ⚠️ The percentage counts a DRIFTED key as UNTRANSLATED, which is the whole point of
      this tool existing. It has a value, so the old arithmetic called it done and printed
      100% over fr/es/de that were still asserting a claim en had already corrected.
    */
    const done = enKeys.length - missing.length - drifted.length
    const pct = Math.floor((done / enKeys.length) * 100)
    const notes = [`${missing.length} untranslated`]
    if (drifted.length) notes.push(`${drifted.length} DRIFTED`)
    if (stale.length) notes.push(`${stale.length} STALE`)
    console.log(`── ${file} — ${pct}% translated (${notes.join(', ')})`)
    if (stale.length) console.log(`   ⚠️ stale (not in en, remove): ${stale.join(', ')}`)
    if (drifted.length) {
      console.log(`   🚨 DRIFTED — English changed after these were translated:`)
      for (const k of drifted) {
        console.log(`      • ${k}`)
        console.log(`          en now: ${JSON.stringify(en[k])}`)
        console.log(`          ${locale} still: ${JSON.stringify(loc[k])}`)
      }
    }
    if (unstamped.length) {
      console.log(
        `   ℹ️ ${unstamped.length} translated key(s) have no recorded source — drift CANNOT be`,
      )
      console.log(`      detected for them until \`i18n baseline ${locale}\` runs. Not a failure.`)
    }
    for (const k of missing) console.log(`   • ${k} = ${JSON.stringify(en[k])}`)
    console.log('')
  }
  return 0
}

function cmdGet(glob) {
  if (!glob) { console.error('usage: i18n get <dotted-glob>   e.g. "vaults.pend*"'); return 1 }
  const re = globToRe(glob)
  const flat = Object.fromEntries(localeFiles().map((f) => [f.replace('.json', ''), flatten(load(f))]))
  const keys = Object.keys(flat.en).filter((k) => re.test(k))
  if (keys.length === 0) { console.log(`(no keys match ${glob})`); return 0 }
  for (const k of keys) {
    console.log(k)
    for (const [loc, data] of Object.entries(flat)) {
      const v = data[k]
      console.log(`   ${loc}: ${v === undefined ? '—' : JSON.stringify(v)}`)
    }
  }
  return 0
}

function cmdSet(argv) {
  const key = argv[0]
  if (!key || key.startsWith('--')) { console.error('usage: i18n set <key> --en "…" [--fr "…"] …'); return 1 }
  const vals = {}
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) { console.error(`bad flag: ${argv[i]}`); return 1 }
    vals[argv[i].slice(2)] = argv[i + 1]
  }
  const known = localeFiles().map((f) => f.replace('.json', ''))
  let enFlat = flatten(load('en.json'))
  if (!(key in enFlat) && !('en' in vals)) { console.error(`new key "${key}" needs --en`); return 1 }

  /*
    ⚠️ ORDER MATTERS: write en FIRST, then stamp the others against it. Stamping a
    translation against the OLD English would record it as current at the exact moment
    it went stale — the drift this tool exists to catch, manufactured by the tool.
  */
  if ('en' in vals) {
    const data = load('en.json')
    setPath(data, key, vals.en)
    writeLocale('en.json', data)
    enFlat = flatten(load('en.json'))
  }

  let n = 0
  for (const [loc, text] of Object.entries(vals)) {
    if (loc === 'en') { n++; continue }
    if (!known.includes(loc)) { console.warn(`skip: no ${loc}.json`); continue }
    const data = load(`${loc}.json`)
    setPath(data, key, text)
    writeLocale(`${loc}.json`, data)
    stamp(loc, [key], enFlat)
    n++
  }

  /*
    Reworded en with no translations alongside it. This is the exact move that produced
    the hole, so it warns HERE rather than waiting for CI - the fix is cheapest while the
    English is still in your head.
  */
  if ('en' in vals) {
    const behind = known.filter(
      (l) => l !== 'en' && driftedKeys(l, enFlat).includes(key),
    )
    if (behind.length) {
      console.warn(`⚠️ ${key}: en changed but ${behind.join(', ')} did not — they now assert the OLD text.`)
      console.warn(`   Pass --${behind[0]} "…" in the same command, or i18n:check will fail.`)
    }
  }
  console.log(`set ${key} in ${n} locale(s).`)
  return 0
}

function cmdApply(arg) {
  const input = arg && arg !== '-' && existsSync(arg) ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8')
  let map
  try { map = JSON.parse(input) } catch (e) { console.error('invalid JSON:', e.message); return 1 }
  const known = new Set(localeFiles().map((f) => f.replace('.json', '')))
  const locales = new Set()
  for (const per of Object.values(map)) for (const l of Object.keys(per)) locales.add(l)
  let applied = 0
  // en first, for the same reason as `set`: everything else is stamped against it.
  const ordered = [...locales].sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : 0))
  for (const loc of ordered) {
    if (!known.has(loc)) { console.warn(`skip: no ${loc}.json`); continue }
    const data = load(`${loc}.json`)
    const touched = []
    for (const [key, per] of Object.entries(map)) if (per[loc] != null) { setPath(data, key, per[loc]); touched.push(key) }
    writeLocale(`${loc}.json`, data)
    if (loc !== 'en') stamp(loc, touched, flatten(load('en.json')))
    console.log(`${loc}.json: applied ${touched.length}`)
    applied += touched.length
  }
  console.log(`\nDone — ${applied} translation(s) across ${locales.size} locale(s).`)
  return 0
}

/*
  Adopt drift detection over translations that predate it.

  ⚠️ **This ASSERTS, it does not verify.** It records "this translation matches today's
  English" for every key that has one, which is a claim nobody checked. Run it ONCE per
  repo, at adoption, and treat what it stamps as the trust level those translations
  already had - no better. Running it again later to clear a red CI would silently bless
  exactly the drift the tool exists to find, so it prints what it did and says so.
*/
function cmdBaseline(only) {
  const enFlat = flatten(load('en.json'))
  for (const file of otherFiles()) {
    const locale = file.replace('.json', '')
    if (only && locale !== only) continue
    const already = driftedKeys(locale, enFlat).length
    const fresh = unstampedKeys(locale, enFlat)
    const n = stamp(locale, Object.keys(flatten(load(file))), enFlat)
    console.log(`${file}: stamped ${n} key(s) (${fresh.length} newly tracked, ${already} previously DRIFTED and now cleared)`)
    if (already) {
      console.log(`   ⚠️  ${already} key(s) were reported as drifted and have just been declared correct.`)
      console.log(`      If that was not deliberate, retranslate them and re-run instead.`)
    }
  }
  console.log(`
Baseline recorded. From here, a reworded en string shows up in i18n:report and fails i18n:check.`)
  return 0
}

// ---- dispatch -------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2)
const run = {
  check: () => cmdCheck(),
  missing: () => cmdMissing(rest[0]),
  get: () => cmdGet(rest[0]),
  set: () => cmdSet(rest),
  apply: () => cmdApply(rest[0]),
  baseline: () => cmdBaseline(rest[0]),
}[cmd]
if (!run) {
  console.error('usage: node scripts/i18n.mjs <check|missing|get|set|apply|baseline> [args]')
  process.exit(2)
}
process.exit(run())
