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
    expect(() => decryptKeystore(store, 'wrong-passphrase')).toThrow(/wrong passphrase|corrupted/i)
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

  it('rejects non-integer / non-numeric scrypt params instead of crashing with a raw TypeError', () => {
    const pass = 'pw'
    const store = encryptKeystore(sampleEntries(), pass)
    const bad = { ...store, scrypt: { N: NaN, r: 8, p: 1 } }
    expect(() => decryptKeystore(bad, pass)).toThrow(/wrong passphrase|corrupted/i)
    const missing = { ...store, scrypt: undefined as unknown as { N: number; r: number; p: number } }
    expect(() => decryptKeystore(missing, pass)).toThrow(/wrong passphrase|corrupted/i)
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
