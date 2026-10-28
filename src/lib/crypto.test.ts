import { describe, it, expect } from 'vitest'
import { encryptKeystore, decryptKeystore, newId, type KeyEntry } from './crypto.js'

function sampleEntries(): KeyEntry[] {
  return [
    { id: newId(), label: 'Key A', mnemonic: 'abandon '.repeat(11) + 'about', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: newId(), label: 'Key B', mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow', createdAt: '2026-01-02T00:00:00.000Z' },
  ]
}

describe('encrypted keystore', () => {
  it('round-trips entries through encrypt → decrypt', () => {
    const entries = sampleEntries()
    const store = encryptKeystore(entries, 'correct horse battery staple')
    const back = decryptKeystore(store, 'correct horse battery staple')
    expect(back).toEqual(entries)
  })

  it('produces no plaintext secret outside the ciphertext', () => {
    const entries = sampleEntries()
    const store = encryptKeystore(entries, 'pw')
    const blob = JSON.stringify(store)
    expect(blob).not.toContain('abandon')
    expect(blob).not.toContain('sausage')
    expect(blob).not.toContain('Key A')
  })

  it('fails loudly on the wrong passphrase (GCM tag mismatch)', () => {
    const store = encryptKeystore(sampleEntries(), 'right-passphrase')
    expect(() => decryptKeystore(store, 'wrong-passphrase')).toThrow(/passphrase is wrong|damaged/i)
  })

  it('fails on a tampered ciphertext', () => {
    const store = encryptKeystore(sampleEntries(), 'pw')
    // Flip a byte in the ciphertext.
    const ct = Buffer.from(store.ct, 'base64')
    ct[0] ^= 0xff
    const tampered = { ...store, ct: ct.toString('base64') }
    expect(() => decryptKeystore(tampered, 'pw')).toThrow()
  })

  it('uses distinct salt + iv per encryption (no reuse)', () => {
    const a = encryptKeystore(sampleEntries(), 'pw')
    const b = encryptKeystore(sampleEntries(), 'pw')
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('requires a passphrase', () => {
    expect(() => encryptKeystore(sampleEntries(), '')).toThrow(/passphrase/i)
  })

  it('refuses to decrypt an envelope with a downgraded/weak KDF cost, even with the right passphrase', () => {
    const pass = 'correct horse battery staple'
    const store = encryptKeystore(sampleEntries(), pass)
    // Attacker (or a corrupted/malicious "restore" file) downgrades N to make guessing cheap.
    for (const weak of [{ N: 1, r: 8, p: 1 }, { N: 2, r: 8, p: 1 }, { N: 131072, r: 0, p: 1 }, { N: 131072, r: 8, p: 0 }]) {
      const tampered = { ...store, scrypt: weak }
      expect(() => decryptKeystore(tampered, pass)).toThrow()
    }
  })

  it('refuses a KDF cost ABOVE the ceiling before doing any derivation work (2026-10-04)', () => {
    /*
      The floor stops a cheap-to-crack file; nothing stopped an expensive-to-open one. A crafted
      backup with {N: 65536, r: 1, p: 8,000,000} passed the floor and ran scrypt on the main
      thread for days (about 31 ms per unit of p), freezing the restore screen (an ANR on
      Android). noble's 1 GB `maxmem` catches large N and r, not a large p. Refused up front,
      with a message that names the cause, since nothing about the passphrase is revealed.
    */
    const pass = 'pw'
    const store = encryptKeystore(sampleEntries(), pass)
    for (const heavy of [{ N: 65536, r: 1, p: 5 }, { N: 2 ** 21, r: 8, p: 1 }, { N: 65536, r: 17, p: 1 }]) {
      const started = Date.now()
      expect(() => decryptKeystore({ ...store, scrypt: heavy }, pass)).toThrow(/far more key-stretching work/i)
      expect(Date.now() - started, `${JSON.stringify(heavy)} must be refused before scrypt runs`).toBeLessThan(150)
    }
  })

  it('still opens the heaviest cost the ceiling allows', () => {
    // N 2^20 at r 8 would need noble's whole 1 GB, so the boundary is exercised where it is cheap.
    const pass = 'pw'
    const store = encryptKeystore(sampleEntries(), pass)
    expect(() => decryptKeystore({ ...store, scrypt: { N: 65536, r: 16, p: 4 } }, pass)).toThrow(/passphrase is wrong|damaged/i)
  })

  it('rejects non-integer / non-numeric scrypt params instead of crashing with a raw TypeError', () => {
    const pass = 'pw'
    const store = encryptKeystore(sampleEntries(), pass)
    const bad = { ...store, scrypt: { N: NaN, r: 8, p: 1 } }
    expect(() => decryptKeystore(bad, pass)).toThrow(/passphrase is wrong|damaged/i)
    const missing = { ...store, scrypt: undefined as unknown as { N: number; r: number; p: number } }
    expect(() => decryptKeystore(missing, pass)).toThrow(/passphrase is wrong|damaged/i)
  })

  it('handles a keystore with missing/malformed fields without crash-leaking (loud generic error)', () => {
    const pass = 'pw'
    const store = encryptKeystore(sampleEntries(), pass)
    const cases = [
      { ...store, salt: undefined as unknown as string },
      { ...store, iv: 'not-base64!!!' },
      { ...store, ct: '' },
      { ...store, tag: '@@@' },
      {} as typeof store,
      null as unknown as typeof store,
    ]
    for (const c of cases) {
      expect(() => decryptKeystore(c, pass)).toThrow()
    }
  })

  it('a truncated/short IV or tag fails authentication rather than decrypting', () => {
    const pass = 'pw'
    const store = encryptKeystore(sampleEntries(), pass)
    const shortIv = { ...store, iv: Buffer.from([1, 2, 3]).toString('base64') }
    expect(() => decryptKeystore(shortIv, pass)).toThrow()
    const shortTag = { ...store, tag: Buffer.from([1, 2]).toString('base64') }
    expect(() => decryptKeystore(shortTag, pass)).toThrow()
  })
})
