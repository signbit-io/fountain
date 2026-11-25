import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { generateKey, isValidMnemonic } from './key.js'

/*
  SEED ENTROPY — the one defect with no recovery.

  Every other bug in this app is fixable in a later release. Bad entropy compromises every key
  from birth, the vault looks perfectly normal, and no update can repair a mnemonic already
  written on paper. So the source is asserted here rather than assumed from the library.

  ⚠️ These tests deliberately assert properties of the DEPENDENCY (@scure/bip39 → @noble/hashes
  randomBytes → crypto.getRandomValues), not just our own code. Our code is one line —
  `generateMnemonic(wordlist, 256)` — and every way this can go wrong lives underneath it: a
  package swap, a polyfill that silently substitutes Math.random, a bundler resolving a
  browser shim with a weaker fallback. A test that only exercised our line would pass through
  all of them.
*/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SECURITY: seed entropy source', () => {
  it('generates a 24-word (256-bit) mnemonic', () => {
    const m = generateKey()
    expect(m.split(' ')).toHaveLength(24)
    expect(isValidMnemonic(m)).toBe(true)
    // 24 words encodes exactly 32 bytes of entropy — a shorter phrase would still be VALID
    // BIP-39, so word count alone is not the assertion that matters.
    expect(mnemonicToEntropy(m, wordlist)).toHaveLength(32)
  })

  it('draws from crypto.getRandomValues, not Math.random', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    const mathRandom = vi.spyOn(Math, 'random')

    generateKey()

    expect(spy).toHaveBeenCalled()
    // The bytes requested must cover the full 256 bits in one draw.
    const requested = spy.mock.calls.reduce((n, [buf]) => n + (buf as Uint8Array).length, 0)
    expect(requested).toBeGreaterThanOrEqual(32)
    expect(mathRandom).not.toHaveBeenCalled()

    spy.mockRestore()
    mathRandom.mockRestore()
  })

  it('has NO weak fallback in the entropy path — it throws instead of degrading', async () => {
    // The property that matters is the ABSENCE of a Math.random fallback: a generator that
    // quietly degraded on a platform without WebCrypto would produce guessable keys that look
    // identical to good ones forever after.
    //
    // ⚠️ This CANNOT be tested by stubbing globalThis.crypto — @noble/hashes binds it at MODULE
    // LOAD, so a later stub never reaches the captured reference (verified: the phrase still
    // generates). Asserting through a stub would therefore be a test that passes for the wrong
    // reason. Instead, assert the shipped source of the function we depend on.
    const { readFileSync } = await import('node:fs')
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)

    // ⚠️ Check the ESM build, not the CJS one. `require.resolve` returns `utils.js` (the
    // "require" export), but Vite and Vitest both load `esm/utils.js` — so scraping the CJS
    // copy would pass while the file that actually ships into the app was compromised.
    // Verified by mutation: swapping getRandomValues for Math.random in esm/utils.js is
    // invisible to a CJS read.
    const path = await import('node:path')
    const cjs = req.resolve('@noble/hashes/utils')
    const esm = path.join(path.dirname(cjs), 'esm', 'utils.js')
    const src = readFileSync(esm, 'utf8')

    const fn = src.slice(src.indexOf('function randomBytes'))
    const body = fn.slice(0, fn.indexOf(String.fromCharCode(10) + '}'))

    expect(body).toContain('getRandomValues')
    expect(body).toContain('throw new Error')
    // The failure this guards against by name.
    expect(body).not.toContain('Math.random')
  })

  it('produces no duplicates and no stuck bits across many draws', () => {
    const N = 400
    const seen = new Set<string>()
    const ones = new Array(256).fill(0)

    for (let i = 0; i < N; i++) {
      const m = generateMnemonic(wordlist, 256)
      seen.add(m)
      const ent = mnemonicToEntropy(m, wordlist)
      for (let b = 0; b < 32; b++) {
        for (let bit = 0; bit < 8; bit++) {
          if (ent[b] & (1 << bit)) ones[b * 8 + bit]++
        }
      }
    }

    // A repeat inside a few hundred 256-bit draws means the source is not what it claims.
    expect(seen.size).toBe(N)

    // A bit that never flips is the signature of a truncated or partially-filled buffer —
    // the failure mode where entropy looks random but occupies fewer bits than advertised.
    const stuck = ones.filter((c) => c === 0 || c === N)
    expect(stuck).toHaveLength(0)

    // Loose bounds: this is a smoke test for a broken source, not a randomness certification.
    // At N=400 a fair bit lands near 200; anything outside 25–75% is structurally wrong.
    for (const c of ones) {
      expect(c).toBeGreaterThan(N * 0.25)
      expect(c).toBeLessThan(N * 0.75)
    }
  })

  it('every generated mnemonic passes its own checksum', () => {
    // BIP-39's last word encodes a checksum over the entropy. A generator writing malformed
    // entropy would produce phrases that fail here — and, worse, that other wallets reject
    // when the user tries to restore.
    for (let i = 0; i < 50; i++) {
      expect(isValidMnemonic(generateKey())).toBe(true)
    }
  })
})
