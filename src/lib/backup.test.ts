import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createBackup,
  readBackup,
  collectBackupPayload,
  defaultBackupFilename,
  BACKUP_FORMAT_VERSION,
  BACKUP_TYPE,
  type BackupPayload,
} from './backup.js'
import type { KeyEntry } from './crypto.js'

/*
  Backup format tests. The whole point of this file is PORTABILITY — a backup written by any
  build must open on any other build, on any OS, including ones that don't exist yet. So these
  tests pin the things that would silently break that: the on-disk shape, the version contract,
  and the guarantee that no secret sits outside the ciphertext.
*/

const PASS = 'correct horse battery staple'

const KEYS: KeyEntry[] = [
  { id: 'a1', label: 'Main key', mnemonic: 'abandon '.repeat(23) + 'about', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'b2', label: 'Backup key', mnemonic: 'legal '.repeat(23) + 'winner', createdAt: '2026-02-01T00:00:00.000Z' },
]

const PAYLOAD: BackupPayload = {
  keys: KEYS,
  vaults: [
    {
      id: 'v1',
      label: 'Family vault',
      descriptor: 'wsh(sortedmulti(2,[73c5da0a/48h/1h/0h/2h]tpubDX/0/*))#checksum',
      changeDescriptor: 'wsh(sortedmulti(2,[73c5da0a/48h/1h/0h/2h]tpubDX/1/*))#checksum',
      savedAt: '2026-03-01T00:00:00.000Z',
    },
  ],
  settings: { autoLockMinutes: 5, theme: 'dark', network: 'testnet' },
  locale: 'fr',
}

describe('backup round-trip', () => {
  it('restores every part of the payload byte-for-byte', () => {
    const file = createBackup(PAYLOAD, PASS)
    const out = readBackup(JSON.stringify(file), PASS)
    expect(out).toEqual(PAYLOAD)
  })

  it('preserves seeds exactly — the irreplaceable part', () => {
    const file = createBackup(PAYLOAD, PASS)
    const out = readBackup(JSON.stringify(file), PASS)
    expect(out.keys).toHaveLength(2)
    expect(out.keys[0]!.mnemonic).toBe(KEYS[0]!.mnemonic)
    expect(out.keys[1]!.mnemonic).toBe(KEYS[1]!.mnemonic)
    expect(out.keys.map((k) => k.label)).toEqual(['Main key', 'Backup key'])
  })

  it('carries vault descriptors across — a keystore-only copy would lose these', () => {
    const file = createBackup(PAYLOAD, PASS)
    const out = readBackup(JSON.stringify(file), PASS)
    expect(out.vaults[0]!.descriptor).toBe(PAYLOAD.vaults[0]!.descriptor)
    expect(out.vaults[0]!.changeDescriptor).toBe(PAYLOAD.vaults[0]!.changeDescriptor)
  })
})

describe('the file is inert, portable text', () => {
  it('survives a JSON stringify→parse trip intact (what moving it through cloud storage does)', () => {
    const file = createBackup(PAYLOAD, PASS)
    const rehydrated = JSON.parse(JSON.stringify(file))
    expect(readBackup(JSON.stringify(rehydrated), PASS)).toEqual(PAYLOAD)
  })

  it('contains NO plaintext secret anywhere outside the ciphertext', () => {
    const file = createBackup(PAYLOAD, PASS)
    const { ct, ...withoutCiphertext } = file
    const serialized = JSON.stringify(withoutCiphertext)
    expect(ct.length).toBeGreaterThan(0)
    // No mnemonic word, label, descriptor, or the passphrase itself may leak into metadata.
    expect(serialized).not.toContain('abandon')
    expect(serialized).not.toContain('legal')
    expect(serialized).not.toContain('Main key')
    expect(serialized).not.toContain('Family vault')
    expect(serialized).not.toContain('tpubDX')
    expect(serialized).not.toContain(PASS)
  })

  it('declares the KDF params INSIDE the file, so a future cost bump cannot orphan it', () => {
    const file = createBackup(PAYLOAD, PASS)
    expect(file.scrypt.N).toBeGreaterThanOrEqual(65536)
    expect(typeof file.scrypt.r).toBe('number')
    expect(typeof file.scrypt.p).toBe('number')
    expect(file.kdf).toBe('scrypt')
    expect(file.cipher).toBe('aes-256-gcm')
  })

  it('uses fresh salt + iv per export, so two backups of identical data differ', () => {
    const a = createBackup(PAYLOAD, PASS)
    const b = createBackup(PAYLOAD, PASS)
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
    // ...and both still decrypt to the same payload.
    expect(readBackup(JSON.stringify(a), PASS)).toEqual(readBackup(JSON.stringify(b), PASS))
  })
})

describe('version contract (the cross-compatibility guarantee)', () => {
  it('stamps the FORMAT version and the writing app build as separate fields', () => {
    const file = createBackup(PAYLOAD, PASS)
    expect(file.type).toBe(BACKUP_TYPE)
    expect(file.version).toBe(BACKUP_FORMAT_VERSION)
    // createdWith is the APP version — informational, and must not be confused with `version`.
    expect(typeof file.createdWith).toBe('string')
    expect(file.createdWith).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('a backup from a NEWER format fails with an actionable message, not a decrypt error', () => {
    const file = { ...createBackup(PAYLOAD, PASS), version: BACKUP_FORMAT_VERSION + 1 }
    expect(() => readBackup(JSON.stringify(file), PASS)).toThrow(/newer version/i)
  })

  it('still reads a file whose createdWith is an unknown/older build (app version is never branched on)', () => {
    const file = { ...createBackup(PAYLOAD, PASS), createdWith: '0.0.1-ancient' }
    expect(readBackup(JSON.stringify(file), PASS)).toEqual(PAYLOAD)
  })
})

describe('rejects bad input loudly', () => {
  it('refuses the wrong passphrase', () => {
    const file = createBackup(PAYLOAD, PASS)
    expect(() => readBackup(JSON.stringify(file), 'wrong passphrase')).toThrow(/wrong passphrase|corrupted/i)
  })

  it('refuses a tampered ciphertext (AEAD catches it)', () => {
    const file = createBackup(PAYLOAD, PASS)
    const flipped = Buffer.from(file.ct, 'base64')
    flipped[0] ^= 0xff
    const tampered = { ...file, ct: flipped.toString('base64') }
    expect(() => readBackup(JSON.stringify(tampered), PASS)).toThrow()
  })

  it('refuses a tampered auth tag', () => {
    const file = createBackup(PAYLOAD, PASS)
    const flipped = Buffer.from(file.tag, 'base64')
    flipped[0] ^= 0xff
    expect(() => readBackup(JSON.stringify({ ...file, tag: flipped.toString('base64') }), PASS)).toThrow()
  })

  it('refuses a DOWNGRADED KDF cost — an attacker must not make guessing cheap', () => {
    const file = createBackup(PAYLOAD, PASS)
    const weak = { ...file, scrypt: { N: 2, r: 1, p: 1 } }
    expect(() => readBackup(JSON.stringify(weak), PASS)).toThrow()
  })

  it('refuses a file that is not a SignBit backup', () => {
    expect(() => readBackup(JSON.stringify({ hello: 'world' }), PASS)).toThrow(/isn't a SignBit backup/i)
  })

  it('refuses a keystore file passed to the backup reader by mistake', () => {
    // A raw keystore envelope has no `type` marker — it must not be mistaken for a backup.
    const keystoreShaped = { version: 1, kdf: 'scrypt', cipher: 'aes-256-gcm', scrypt: { N: 131072, r: 8, p: 1 }, salt: 'x', iv: 'y', tag: 'z', ct: 'w' }
    expect(() => readBackup(JSON.stringify(keystoreShaped), PASS)).toThrow(/isn't a SignBit backup/i)
  })

  it('refuses non-JSON', () => {
    expect(() => readBackup('not json at all', PASS)).toThrow(/valid JSON/i)
  })

  it('refuses a backup with no keys in it', () => {
    const empty = createBackup({ keys: [], vaults: [] }, PASS)
    expect(() => readBackup(JSON.stringify(empty), PASS)).toThrow(/no keys/i)
  })
})

describe('tolerates older / partial payloads (forward-compat within a format version)', () => {
  it('restores when optional settings + locale are absent', () => {
    const minimal = createBackup({ keys: KEYS, vaults: [] }, PASS)
    const out = readBackup(JSON.stringify(minimal), PASS)
    expect(out.keys).toHaveLength(2)
    expect(out.vaults).toEqual([])
    expect(out.locale).toBeUndefined()
  })

  it('drops malformed vault entries rather than failing the whole restore', () => {
    // Losing a descriptor cache must never cost someone their seeds.
    const messy = createBackup(
      { keys: KEYS, vaults: [{ id: 'ok', label: 'Good', descriptor: 'wsh(...)', savedAt: 'x' }, { nope: true }] as never },
      PASS,
    )
    const out = readBackup(JSON.stringify(messy), PASS)
    expect(out.keys).toHaveLength(2)
    expect(out.vaults).toHaveLength(1)
    expect(out.vaults[0]!.id).toBe('ok')
  })

  /*
    Cosigner names (VaultBackup.keyLabels) ride inside the ENCRYPTED payload like everything
    else here — there is no cleartext section of this file to leak them into. The pair of
    tests below pins the compatibility claim that let this ship WITHOUT bumping
    BACKUP_FORMAT_VERSION: an optional additive field is not a structural change.
  */
  it('carries cosigner names through an export/restore round trip', () => {
    const withNames = createBackup(
      {
        keys: KEYS,
        vaults: [
          {
            id: 'v1',
            label: 'Family',
            descriptor: 'wsh(...)',
            savedAt: 'x',
            keyLabels: { aaaaaaaa: 'Alice', bbbbbbbb: 'Bob' },
          },
        ],
      },
      PASS,
    )
    const out = readBackup(JSON.stringify(withNames), PASS)
    expect(out.vaults[0]!.keyLabels).toEqual({ aaaaaaaa: 'Alice', bbbbbbbb: 'Bob' })
  })

  it('restores an OLDER backup that predates cosigner names, with no names and no error', () => {
    // The backwards half of the contract: format version is unchanged, so a file written
    // before keyLabels existed restores exactly as it always did.
    const old = createBackup(
      { keys: KEYS, vaults: [{ id: 'v1', label: 'Family', descriptor: 'wsh(...)', savedAt: 'x' }] },
      PASS,
    )
    const out = readBackup(JSON.stringify(old), PASS)
    expect(out.vaults).toHaveLength(1)
    expect(out.vaults[0]!.keyLabels).toBeUndefined()
  })

  it('coerces a hand-edited cosigner-name map instead of trusting it', () => {
    const tampered = createBackup(
      {
        keys: KEYS,
        vaults: [
          {
            id: 'v1',
            label: 'Family',
            descriptor: 'wsh(...)',
            savedAt: 'x',
            keyLabels: { AAAAAAAA: 'Alice', 'not-a-fingerprint': 'X', bbbbbbbb: 42 },
          } as never,
        ],
      },
      PASS,
    )
    const out = readBackup(JSON.stringify(tampered), PASS)
    expect(out.vaults[0]!.keyLabels).toEqual({ aaaaaaaa: 'Alice' })
  })

  it('drops key entries with no mnemonic but keeps the valid ones', () => {
    const messy = createBackup({ keys: [KEYS[0]!, { id: 'x', label: 'broken' } as never], vaults: [] }, PASS)
    const out = readBackup(JSON.stringify(messy), PASS)
    expect(out.keys).toHaveLength(1)
    expect(out.keys[0]!.id).toBe('a1')
  })

  /*
    ⚠️ The assumption that lets KeyEntry.network ship WITHOUT bumping BACKUP_FORMAT_VERSION.

    normalizePayload filters keys on id/mnemonic and passes the object through, so unknown
    fields ride along. If a future refactor ever rebuilds those objects field-by-field instead,
    the stamp would silently vanish — and a restored mainnet key would read as testnet, deriving
    a different xpub than the vault it was enrolled in. Bumping the format version was the wrong
    fix for that (it would make every new backup unreadable by the previous build, on the
    restore path); pinning the behaviour is the right one.
  */
  it('carries a key\'s NETWORK STAMP through a backup round-trip', () => {
    const stamped: KeyEntry[] = [
      { ...KEYS[0]!, network: 'mainnet' },
      { ...KEYS[1]!, network: 'testnet' },
    ]
    const out = readBackup(JSON.stringify(createBackup({ keys: stamped, vaults: [] }, PASS)), PASS)
    expect(out.keys.map((k) => k.network)).toEqual(['mainnet', 'testnet'])
  })

  it('leaves an UNSTAMPED key unstamped (the caller decides the fallback)', () => {
    // Pre-mainnet backups have no stamp. readBackup must not invent one — networkOf() and the
    // unlock-time backfill own that decision, in one place, where it is documented.
    const out = readBackup(JSON.stringify(createBackup({ keys: KEYS, vaults: [] }, PASS)), PASS)
    expect(out.keys[0]!.network).toBeUndefined()
  })
})

describe('collectBackupPayload', () => {
  // The suite runs in Vitest's NODE environment (the crypto/key libs are pure, so no DOM is
  // configured globally). collectBackupPayload is the one function here that reads
  // localStorage, so give it a minimal in-memory stand-in rather than pulling jsdom into the
  // whole project for three assertions.
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size
      },
    })
  })

  it('gathers vaults, settings and locale off the device', () => {
    localStorage.setItem('signbit.locale', 'de')
    localStorage.setItem('signbit.settings', JSON.stringify({ autoLockMinutes: 15, theme: 'light' }))
    localStorage.setItem(
      'signbit.vaults',
      JSON.stringify([{ id: 'v9', label: 'V', descriptor: 'wsh(x)', savedAt: '2026-01-01T00:00:00.000Z' }]),
    )

    const payload = collectBackupPayload(KEYS)
    expect(payload.keys).toBe(KEYS)
    expect(payload.locale).toBe('de')
    expect(payload.settings?.autoLockMinutes).toBe(15)
    expect(payload.vaults).toHaveLength(1)
  })

  it('EXCLUDES per-card UI state (signbit.card.*) — ephemera, not state worth restoring', () => {
    localStorage.setItem('signbit.card.someCard', '1')
    const payload = collectBackupPayload(KEYS)
    expect(JSON.stringify(payload)).not.toContain('someCard')
  })

  it('works on a fresh device with nothing saved yet', () => {
    const payload = collectBackupPayload(KEYS)
    expect(payload.vaults).toEqual([])
    expect(payload.locale).toBeUndefined()
  })
})

describe('defaultBackupFilename', () => {
  it('is dated so successive backups sort and never silently overwrite', () => {
    expect(defaultBackupFilename(new Date('2026-07-25T12:00:00Z'))).toBe('signbit-backup-2026-07-25.json')
    expect(defaultBackupFilename(new Date('2026-01-05T12:00:00Z'))).toBe('signbit-backup-2026-01-05.json')
  })

  it('is findable by searching a drive for either "signbit" or "backup"', () => {
    const name = defaultBackupFilename()
    expect(name).toContain('signbit')
    expect(name).toContain('backup')
    expect(name.endsWith('.json')).toBe(true)
  })
})
