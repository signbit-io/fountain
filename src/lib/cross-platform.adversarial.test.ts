import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, sep } from 'node:path'
import { randomBytes, createCipheriv } from 'node:crypto'
import { scrypt } from '@noble/hashes/scrypt'
import { encodeToFrames, parseFrame, FrameCollector } from './qr.js'
import { encryptPayload, decryptPayload } from './crypto.js'

/*
  THE CROSS-PLATFORM SEAMS, AND THE ANDROID CONFIGURATION.

  🚨 EVERY OTHER TEST IN THIS REPO RUNS PURE TYPESCRIPT, so nothing here has ever asserted
  anything about the two places Fountain's security is decided by CONFIGURATION rather than by
  code: `src-tauri/tauri.conf.json` (the WebView's CSP) and the Android manifest (backup
  extraction, screenshot capture, what is exported). Those files are hand-edited, they sit
  under `gen/` where they look auto-generated and therefore untouchable, and a regression in
  them is invisible — the app builds, launches and behaves identically.

  ⚠️ THESE ARE FILE-CONTENT ASSERTIONS AND THAT IS THE POINT. A config setting has no runtime
  surface to exercise from vitest, so the executable form of "the release must not ship with
  backups enabled" is reading the manifest. Written by the 2026-09-18 Android / cross-platform
  adversarial pass, which found every one of them wrong or absent.
*/

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8')

const MANIFEST = 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'
const MAIN_ACTIVITY = 'src-tauri/gen/android/app/src/main/java/io/signbit/fountain/MainActivity.kt'

/* ──────────────────── seam 1: the QR wire contract between the repos ──────────────────── */

describe('🚨 CROSS-PLATFORM: the QR frame collector must not splice two payloads', () => {
  /*
    `FrameCollector`'s own docstring promises that a wrong QR scanned mid-sequence "fails
    loudly instead of corrupting the result". It delivers that for a frame carrying a
    DIFFERENT `id` — and not at all for one carrying the SAME id and the same `n` with
    different data at an index already captured, which `add` silently overwrote, last write
    wins, still returning 'ok'.

    `id` is 8 hex characters over a NON-cryptographic digest (sha256-truncated here, FNV-1a on
    the platform — see qr-payload-id.ts), asserted by the sender and never re-derived from the
    reassembled payload. It is a grouping tag, not a commitment. So "same id" is something a
    frame can simply CLAIM, whether by an attacker reading it off the screen the victim is
    scanning or by an ordinary collision, and the user is shown "3 of 3 frames" over a payload
    that is not the one the platform displayed.

    ⚠️ THE RESIDUAL RISK IS REAL BUT BOUNDED, AND THAT IS WHY THE FIX IS "REFUSE" RATHER THAN
    "VERIFY THE DIGEST": the reassembled PSBT is still decoded and shown before signing, so a
    splice is a transaction the user can read and reject, not a silent theft
    (display-vs-signature.test.ts is what makes that true). Re-deriving the id from the
    finished payload would be the stronger check and is deliberately NOT done — the platform
    computes `id` with a different algorithm on purpose, so verifying it here would reject
    every genuine platform-sent PSBT. Refusing a CONFLICT needs no cross-repo agreement at all:
    it compares the sender's frames only against each other.

    ⚠️ THIS FILE IS THE ORIGIN OF A CROSS-REPO COPY. The platform holds the same
    `FrameCollector`, byte-identical under a drift guard that lives in that repo and fails ITS
    ci on divergence. A fix here is not finished until it is re-copied — client → platform,
    never the reverse (GPL).
  */
  const framesFor = (payload: string) => encodeToFrames(payload).map((f) => {
    const p = parseFrame(f)
    if (p.status !== 'ok') throw new Error('fixture frame did not parse')
    return p.frame
  })

  it('refuses a frame that CONTRADICTS an index already captured', () => {
    const genuine = framesFor('A'.repeat(1200)) // 3 frames at CHUNK_SIZE
    expect(genuine.length).toBeGreaterThan(1)

    const collector = new FrameCollector()
    expect(collector.add(genuine[0])).toBe('ok')
    expect(collector.add(genuine[1])).toBe('ok')

    // The attacker's frame: the victim's own id and n, an index already held, different data.
    const spliced = { ...genuine[1], d: 'Z'.repeat(genuine[1].d.length) }
    expect(collector.add(spliced), 'a conflicting chunk for a captured index is not "ok"').toBe('mismatch')

    expect(collector.add(genuine[2])).toBe('ok')
    expect(collector.finish(), 'the genuine payload must survive the attempt').toBe('A'.repeat(1200))
  })

  it('still accepts an IDENTICAL re-scan of a frame already held', () => {
    // Re-scanning the same code is the normal case — the user sweeps back over frame 1 while
    // lining up frame 2. It must stay 'ok', or the guard turns ordinary use into an error.
    const genuine = framesFor('B'.repeat(1200))
    const collector = new FrameCollector()
    expect(collector.add(genuine[0])).toBe('ok')
    expect(collector.add(genuine[0])).toBe('ok')
    expect(collector.progress()).toEqual({ have: 1, total: genuine.length })
  })
})

/* ──────────────────── seam 2: the Android application configuration ──────────────────── */

describe('🚨 ANDROID: the encrypted keystore must not be extractable from the device', () => {
  /*
    Android defaults `allowBackup` to TRUE, so this app shipped with Google Auto Backup copying
    its private data dir — where `signbit-keystore.json` lives — to the user's Drive, and with
    `adb backup` able to pull it off a device someone has in hand. An air-gapped signer whose
    key envelope is in a cloud account is not air-gapped.

    Both settings are asserted because they cover different Android versions, not because one
    is a fallback for the other: `allowBackup` governs ≤ 30, `dataExtractionRules` governs 31+
    AND adds device-to-device transfer, which `allowBackup` never covered.
  */
  const manifest = () => read(MANIFEST)

  it('declares allowBackup="false"', () => {
    expect(manifest()).toMatch(/android:allowBackup="false"/)
  })

  it('points at data-extraction rules that refuse BOTH cloud backup and device transfer', () => {
    expect(manifest()).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/)
    const rules = read('src-tauri/gen/android/app/src/main/res/xml/data_extraction_rules.xml')
    expect(rules).toMatch(/<cloud-backup>/)
    expect(rules).toMatch(/<device-transfer>/)
    // `root` covers the app's whole private data dir — the keystore included.
    expect(rules.match(/<exclude domain="root" \/>/g) ?? []).toHaveLength(2)
  })

  it('exports exactly ONE activity, and only as the launcher', () => {
    /*
      An exported component is an entry point any installed app can invoke. MainActivity has to
      be exported (it is the launcher), but nothing else may be, and it must carry no extra
      intent filter — no deep link, no VIEW/SEND handler — because each one is a way for
      another app to drive this one's UI with data of its choosing.
    */
    const m = manifest()
    expect(m.match(/android:exported="true"/g) ?? [], 'only the launcher activity').toHaveLength(1)
    expect(m).toMatch(/android\.intent\.category\.LAUNCHER/)
    expect(m).not.toMatch(/android\.intent\.action\.(VIEW|SEND|EDIT)/)
    // The FileProvider is how a shared file gets a content:// URI; it must stay unexported so
    // a URI only ever reaches another app through an explicit per-URI grant.
    expect(m).toMatch(/androidx\.core\.content\.FileProvider[\s\S]*?android:exported="false"/)
  })

  it('release builds refuse cleartext traffic', () => {
    expect(read('src-tauri/gen/android/app/build.gradle.kts')).toMatch(
      /defaultConfig[\s\S]*?manifestPlaceholders\["usesCleartextTraffic"\] = "false"/,
    )
  })
})

describe('🚨 ANDROID: the window must not be screenshottable', () => {
  /*
    This app puts BIP-39 seed phrases on the screen. Without FLAG_SECURE, Android screenshots
    them, screen-records them, casts them — and writes a THUMBNAIL of the last frame to the
    recents snapshot store on the way out. That file is the OS's, not this app's: no amount of
    keystore encryption reaches it. Reveal a seed, press Home, and a picture of it persists.

    Asserted on `MainActivity.kt` (the hand-edited file), not on a screenshot — there is no
    honest way to observe this from vitest, and the flag being set once, window-wide, is
    exactly the invariant worth pinning. Window-wide rather than toggled per screen so a future
    screen that shows a mnemonic cannot forget to opt in.
  */
  it('sets FLAG_SECURE on the window in onCreate', () => {
    const src = read(MAIN_ACTIVITY)
    expect(src).toMatch(/window\.setFlags\(\s*WindowManager\.LayoutParams\.FLAG_SECURE/)
    expect(src).toMatch(/import android\.view\.WindowManager/)
  })
})

describe('🚨 WEBVIEW: the CSP is the last thing between an injected script and the seeds', () => {
  /*
    Tauri's default is `csp: null` — no policy at all — and that is what this app shipped with.
    The webview holds decrypted mnemonics in memory while unlocked and can reach the whole IPC
    surface, including `read_keystore_at`, an arbitrary local file read. One injected script (a
    compromised bundled dependency; a payload reaching an HTML sink) could `fetch()` every seed
    out to the network, from an application whose entire premise is that it has no network.

    connect-src is the directive that matters here: there is NO legitimate outbound request in
    this app, so anything beyond 'self' and the IPC origin is by definition exfiltration.
  */
  const csp = (): string => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      app: { security: { csp: string | null } }
    }
    const value = conf.app.security.csp
    expect(value, 'csp must not be null — that is "no policy at all"').not.toBeNull()
    return value as string
  }

  it('confines connect-src to self and the Tauri IPC origin', () => {
    const directive = csp().match(/connect-src ([^;]+)/)?.[1]
    expect(directive).toBeDefined()
    expect(directive).not.toMatch(/\*|https?:\/\/(?!ipc\.localhost)/)
  })

  it('allows no inline or eval SCRIPT', () => {
    const directive = csp().match(/script-src ([^;]+)/)?.[1] as string
    expect(directive).not.toMatch(/unsafe-inline|unsafe-eval/)
  })

  it('closes object-src, frame-src and form-action outright', () => {
    // Sinks this app has no use for, so each one exists only for an attacker.
    const policy = csp()
    for (const directive of ['object-src', 'frame-src', 'form-action']) {
      expect(policy, directive).toContain(`${directive} 'none'`)
    }
  })
})

/* ──────────────── seam 3: the copy that has to travel to the other repo ──────────────── */

describe('🚨 CROSS-REPO: the QR framing origin and its drift guard', () => {
  /*
    The platform holds a verbatim copy of this file's framing logic and fails ITS ci on
    divergence — a byte-for-byte comparison against THIS file, which is strictly stronger than
    anything assertable from here. So the useful assertion on this side is the one a
    client-side change is most likely to break unknowingly: the envelope both sides parse.
  */
  const originPath = resolve(repoRoot, 'src/lib/qr.ts')

  it('pins the frame envelope both repos depend on', () => {
    const src = readFileSync(originPath, 'utf8')
    expect(src).toContain('const FRAME_VERSION = 1')
    expect(src).toMatch(/v: FRAME_VERSION, id, i, n, d/)
  })
})

/* ──────────── seam 4: the passphrase itself, typed on two different keyboards ──────────── */

describe('🚨 CROSS-PLATFORM: the same passphrase typed on two platforms must derive one key', () => {
  /*
    🚨 THE QUIETEST WAY TO LOSE A VAULT FOR EVER, AND NOTHING IN THIS REPO LOOKED AT IT.

    `scrypt` is fed `Buffer.from(passphrase, 'utf8')` — raw bytes, no normalization. Unicode
    lets the SAME character be spelled more than one way: "é" is either U+00E9 (composed, NFC)
    or "e" + U+0301 (decomposed, NFD). They render identically, they compare equal to a human
    reading them off a card, and they are DIFFERENT BYTES.

    Which spelling a keyboard emits is a platform decision, not a user one. A passphrase typed
    on one device and re-typed on another can therefore derive a different key, and every
    failure path in crypto.ts deliberately returns the SAME generic message — so the app says
    "the passphrase is wrong, or the data is damaged" to someone who typed it correctly, with
    no way to tell which and nothing to try differently. On a backup carried to a replacement
    device that is unrecoverable, and it is exactly the moment this product exists for.

    ⚠️ NFKD, matching BIP-39's own rule for mnemonics and passphrases — this app already lives
    in that ecosystem, and agreeing with it beats inventing a second convention.

    ⚠️ THE FALLBACK IS A MIGRATION, NOT A WEAKNESS. Keystores written before this were sealed
    under the RAW bytes, so decrypt tries the normalized form first and the raw form second.
    It costs a second scrypt run ONLY when normalization actually changed the string, so an
    ASCII passphrase (very nearly all of them) pays nothing. It gives an attacker no new
    ground: they already control which bytes they guess with.
  */
  const NFC = 'café-résumé-naïve'
  const NFD = 'café-résumé-naïve'
  const SECRET = JSON.stringify([{ id: 'a', label: 'k', mnemonic: 'abandon abandon about', createdAt: '' }])

  it('the two spellings are genuinely different bytes (the fixture is real)', () => {
    expect(NFC).not.toBe(NFD)
    expect(Buffer.from(NFC, 'utf8').length).not.toBe(Buffer.from(NFD, 'utf8').length)
    expect(NFC.normalize('NFKD')).toBe(NFD.normalize('NFKD'))
  })

  it('sealed with the COMPOSED spelling, opens with the DECOMPOSED one', () => {
    expect(decryptPayload(encryptPayload(SECRET, NFC), NFD)).toBe(SECRET)
  })

  it('sealed with the DECOMPOSED spelling, opens with the COMPOSED one', () => {
    expect(decryptPayload(encryptPayload(SECRET, NFD), NFC)).toBe(SECRET)
  })

  it('a genuinely wrong passphrase is still refused', () => {
    expect(() => decryptPayload(encryptPayload(SECRET, NFC), 'cafe-resume-naive')).toThrow()
  })

  it('opens a LEGACY envelope sealed under the raw un-normalized bytes', () => {
    // Built with the primitives directly, exactly as crypto.ts did before normalization
    // existed — the only faithful way to pin the migration, since encryptPayload now
    // normalizes and so can no longer produce one of these.
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const key = Buffer.from(scrypt(Buffer.from(NFD, 'utf8'), salt, { N: 131072, r: 8, p: 1, dkLen: 32 }))
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(Buffer.from(SECRET, 'utf8')), cipher.final()])
    const legacy = {
      kdf: 'scrypt',
      cipher: 'aes-256-gcm',
      scrypt: { N: 131072, r: 8, p: 1 },
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    }
    expect(decryptPayload(legacy, NFD), 'a keystore written before this must still open').toBe(SECRET)
  })
})

/* ────────────── seam 5: where the salt and the IV actually come from ────────────── */

describe('🚨 CROSS-PLATFORM: the AES-GCM IV must come from the same RNG on both platforms', () => {
  /*
    `entropy.test.ts` guards the SEED, and it is right that it does — but it guards the seed
    only. @scure/bip39 reaches `crypto.getRandomValues` through @noble/hashes, which is
    platform-independent, so the mnemonic was never the exposed half.

    🚨 THE EXPOSED HALF WAS THE SALT AND THE IV. They came from `node:crypto`'s `randomBytes`,
    which in the WebView is not node:crypto at all — Vite swaps in `crypto-browserify` (see
    vite.config.ts). So the module that ran in the shipped app was NEVER THE ONE THE TESTS
    EXERCISED: vitest runs under Node and resolves the real thing. An IV is the one input to
    AES-GCM that must never repeat under a given key; a repeat is not a degraded mode, it
    breaks confidentiality AND forgeability outright.

    ✅ The polyfill turned out to fail closed (`randombytes/browser.js` throws rather than
    reaching for Math.random), so no seed or IV was ever weak. But that was luck held in a
    transitive dependency's browser field, asserted nowhere, one `npm install` from changing —
    and untestable from here by construction, because the tests load the other module.

    The fix removes the question instead of answering it: the salt and IV now come from
    @noble/hashes' `randomBytes`, the SAME source the seed path already uses. It goes straight
    to `crypto.getRandomValues`, it throws when that is absent, it is already a dependency, and
    it is the identical module in Node and in the WebView — so this test now exercises the code
    that actually ships. node:crypto keeps the CIPHER; only the RNG moved.
  */
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('draws the salt and IV from crypto.getRandomValues, never Math.random', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    const mathRandom = vi.spyOn(Math, 'random')

    encryptPayload('x', 'pw')

    expect(spy).toHaveBeenCalled()
    // 16-byte salt + 12-byte IV, both in one encrypt.
    const drawn = spy.mock.calls.reduce((n, [buf]) => n + (buf as Uint8Array).length, 0)
    expect(drawn).toBeGreaterThanOrEqual(28)
    expect(mathRandom).not.toHaveBeenCalled()
  })

  it('FAILS CLOSED when the secure RNG is unavailable — no fallback, no weak IV', () => {
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('getRandomValues unavailable')
    })
    expect(() => encryptPayload('x', 'pw')).toThrow()
    expect(vi.spyOn(Math, 'random')).not.toHaveBeenCalled()
  })

  it('never repeats a salt or an IV across encryptions', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const s = encryptPayload('x', 'pw')
      expect(seen.has(s.salt), 'salt repeated').toBe(false)
      expect(seen.has(s.iv), 'IV repeated').toBe(false)
      seen.add(s.salt)
      seen.add(s.iv)
    }
  })
})

/* ──────────── seam 6: the app's ability to reach a network at all ──────────── */

describe('🚨 OFFLINE BY CONSTRUCTION: the release build must not be able to open a socket', () => {
  /*
    The CSP refuses outbound requests, but that is the APP enforcing a rule on ITSELF — code
    running inside the webview is what decides whether to honour it. `android.permission.INTERNET`
    is the same rule one layer down, in the kernel, where nothing running in this app gets a vote.
    It is granted silently at install (no prompt, no user choice), so an offline signer that
    declares it is simply allowed to talk to the network for no reason.

    ⚠️ DEBUG KEEPS IT. `tauri dev` loads the UI from http://localhost:1420 over `adb reverse` and
    genuinely needs it; a release build serves the UI from inside the APK. Hence a release-scoped
    overlay rather than deleting the line.

    ⚠️ THE ONE CHANGE IN THIS PASS A BUILD CAN DISPROVE — everything else was verified by tests,
    this rests on "a release build needs no socket". Smoke-test a release APK after touching it.
  */
  it('the release manifest removes android.permission.INTERNET', () => {
    const overlay = read('src-tauri/gen/android/app/src/release/AndroidManifest.xml')
    expect(overlay).toMatch(/xmlns:tools="http:\/\/schemas\.android\.com\/tools"/)
    expect(overlay).toMatch(
      /<uses-permission\s+android:name="android\.permission\.INTERNET"\s+tools:node="remove"\s*\/>/,
    )
  })

  it('the MAIN manifest still declares it, so tauri dev keeps working', () => {
    expect(read(MANIFEST)).toMatch(/android\.permission\.INTERNET/)
  })

  it('no source file makes an outbound request', () => {
    /*
      🚨 THE INVARIANT THE WHOLE PRODUCT RESTS ON, AND NOTHING ASSERTED IT.

      There WAS one deliberate exception: the Settings "air-gap check" fetched a neutral host and
      treated the failure as proof of an air gap. That inverts the moment the app stops being able
      to make requests — which is now always. The CSP blocked the fetch, the catch returned
      "offline", and the card told someone on Wi-Fi "Offline confirmed, fully air-gapped". A false
      reassurance on a security screen is worse than none, and it could only have been repaired by
      restoring the capability that was removed to make the air gap real. It was deleted instead.

      ⚠️ So there is now no legitimate caller, and this can be an absolute rule rather than an
      allow-list with one entry — which is the version that actually stays true.
    */
    const files = globSync('src/**/*.{ts,tsx}', { cwd: repoRoot })
      .map((f) => f.split(sep).join('/'))
      .filter((f) => !f.includes('.test.'))
    /*
      WARNING: THE GLOB IS ASSERTED BEFORE IT IS USED, AND THE PATTERN IS TESTED ON ITSELF.
      A pattern that silently matches nothing makes every check below vacuously true, which is
      how a guard like this rots into decoration. It nearly did: the first version of this test
      passed with a deliberately planted `fetch(` sitting in download.ts, because the script
      that generated it turned the intended \b word boundary into a literal BACKSPACE
      character (U+0008). The regex could not match anything, and reported a clean tree.
      Naming files the glob MUST contain, and proving the pattern matches a known-bad string,
      is what turns "no offenders were found" into "no offenders exist".
    */
    expect(files).toContain('src/lib/download.ts')
    expect(files).toContain('src/screens/SettingsScreen.tsx')

    const outbound = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/
    expect(outbound.test('await fetch("x")'), 'the pattern itself must work').toBe(true)

    const offenders = files.filter((f) => outbound.test(read(f)))
    expect(offenders, 'an offline signer makes no requests - see the air-gap check that was removed').toEqual([])
  })
})
