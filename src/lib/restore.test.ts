import { describe, it, expect, vi } from 'vitest'
import { restoreFromKeystoreFile, restoreFromBackupFile, changePassphrase, type RestoreEffects } from './restore.js'
import { createBackup, type BackupPayload } from './backup.js'
import { encryptKeystore, decryptKeystore, type KeyEntry } from './crypto.js'

/*
  RESTORE tests — the commit discipline the user's keys rest on.

  These drive the REAL functions from lib/restore.ts (the same ones KeystoreProvider calls),
  with the storage effects injected as spies. That is the point of the extraction: an earlier
  version of this file transcribed the sequence into local helpers, which asserted a COPY and
  would have kept passing while the production ordering drifted.

  `backup.test.ts` already covers the backup FORMAT (round-trip, version contract, rejection of
  a wrong passphrase / wrong file / empty payload). What is pinned HERE is the ORDERING:

    1. VERIFY BEFORE WRITE — a wrong passphrase must throw before anything reaches storage.
       Inverted, a typo on the restore screen overwrites a good keystore with a file the user
       cannot open. Nothing else in the suite catches it: the crypto still throws, just too late.

    2. KEYS FIRST, side-stores BEST-EFFORT — seeds are irreplaceable, descriptors and prefs are
       a cache the platform can re-supply. A side-store failure must not abort a restore whose
       seeds already landed.
*/

const PASS = 'correct horse battery staple'
const WRONG = 'incorrect horse battery staple'

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
      descriptor: 'wsh(sortedmulti(2,[73c5da0a/48h/1h/0h/2h]tpubDX/0/*))#aaaaaaaa',
      savedAt: '2026-03-01T00:00:00.000Z',
    },
  ],
  settings: { autoLockMinutes: 15, theme: 'dark', network: 'testnet' },
  locale: 'fr',
}

/** Spy effects — records what a restore wrote, and in what order. */
function spyEffects() {
  const order: string[] = []
  const effects: RestoreEffects = {
    writeKeystore: vi.fn(async () => {
      order.push('keystore')
    }),
    writeVaults: vi.fn(() => {
      order.push('vaults')
    }),
    writeSettings: vi.fn(() => {
      order.push('settings')
    }),
    writeLocale: vi.fn(() => {
      order.push('locale')
    }),
  }
  return { effects, order }
}

describe('restoreFromKeystoreFile — adopting an existing keystore file', () => {
  it('does NOT write when the passphrase is wrong (verify before commit)', async () => {
    const store = encryptKeystore(KEYS, PASS)
    const { effects } = spyEffects()

    await expect(restoreFromKeystoreFile(store, WRONG, effects)).rejects.toThrow()
    // THE assertion: a failed restore leaves the active keystore untouched.
    expect(effects.writeKeystore).not.toHaveBeenCalled()
  })

  it('writes the verified envelope VERBATIM and returns the decrypted keys', async () => {
    const store = encryptKeystore(KEYS, PASS)
    const { effects } = spyEffects()

    const entries = await restoreFromKeystoreFile(store, PASS, effects)

    expect(entries).toEqual(KEYS)
    expect(effects.writeKeystore).toHaveBeenCalledTimes(1)
    // Verbatim — never re-encrypted, which would change salt/iv and desync the user's other
    // copies of that same file.
    expect(vi.mocked(effects.writeKeystore).mock.calls[0][0]).toBe(store)
  })

  it('propagates a storage failure rather than reporting a false success', async () => {
    const store = encryptKeystore(KEYS, PASS)
    const { effects } = spyEffects()
    vi.mocked(effects.writeKeystore).mockRejectedValueOnce(new Error('disk full'))

    // The keystore write is the critical one — if it fails the caller must NOT unlock as if
    // the restore had succeeded (the Android 0-byte export bug was this class of mistake).
    await expect(restoreFromKeystoreFile(store, PASS, effects)).rejects.toThrow(/disk full/)
  })
})

describe('restoreFromBackupFile — cross-device move', () => {
  it('does NOT write when the passphrase is wrong', async () => {
    const raw = JSON.stringify(createBackup(PAYLOAD, PASS))
    const { effects } = spyEffects()

    await expect(restoreFromBackupFile(raw, WRONG, effects)).rejects.toThrow(/passphrase is wrong|damaged/i)
    expect(effects.writeKeystore).not.toHaveBeenCalled()
    expect(effects.writeVaults).not.toHaveBeenCalled()
    expect(effects.writeLocale).not.toHaveBeenCalled()
  })

  it('does NOT write when the file is not a backup at all', async () => {
    const { effects } = spyEffects()
    await expect(restoreFromBackupFile('{"hello":"world"}', PASS, effects)).rejects.toThrow(/isn't a SignBit backup/i)
    expect(effects.writeKeystore).not.toHaveBeenCalled()
  })

  it('commits the KEYS BEFORE any side store', async () => {
    const raw = JSON.stringify(createBackup(PAYLOAD, PASS))
    const { effects, order } = spyEffects()

    await restoreFromBackupFile(raw, PASS, effects)

    // The irreplaceable part must land first — everything after it is a re-fetchable cache.
    expect(order[0]).toBe('keystore')
    expect(order).toEqual(['keystore', 'vaults', 'settings', 'locale'])
  })

  it('re-encrypts the keys under the passphrase used to open the backup', async () => {
    const raw = JSON.stringify(createBackup(PAYLOAD, PASS))
    const { effects } = spyEffects()

    await restoreFromBackupFile(raw, PASS, effects)

    // The new device's keystore must open with the same passphrase the user just typed.
    const written = vi.mocked(effects.writeKeystore).mock.calls[0][0]
    expect(decryptKeystore(written, PASS)).toEqual(KEYS)
    expect(() => decryptKeystore(written, WRONG)).toThrow()
  })

  it('keeps the seeds when a side-store write throws (cache failure ≠ key loss)', async () => {
    const raw = JSON.stringify(createBackup(PAYLOAD, PASS))
    const { effects } = spyEffects()
    // Simulate localStorage blowing up: quota, privacy mode, a locked profile.
    vi.mocked(effects.writeVaults).mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })

    // The restore SUCCEEDS despite the side-store failure...
    const payload = await restoreFromBackupFile(raw, PASS, effects)

    // ...and the seeds landed.
    expect(payload.keys).toEqual(KEYS)
    expect(effects.writeKeystore).toHaveBeenCalledTimes(1)
    expect(decryptKeystore(vi.mocked(effects.writeKeystore).mock.calls[0][0], PASS)).toEqual(KEYS)
  })

  it('skips side stores that the backup has nothing for', async () => {
    const raw = JSON.stringify(createBackup({ keys: KEYS, vaults: [] }, PASS))
    const { effects } = spyEffects()

    await restoreFromBackupFile(raw, PASS, effects)

    expect(effects.writeKeystore).toHaveBeenCalledTimes(1)
    // An empty vault list must not clobber whatever is already on the device.
    expect(effects.writeVaults).not.toHaveBeenCalled()
    expect(effects.writeLocale).not.toHaveBeenCalled()
  })

  it('surfaces a newer-format backup as an actionable message, not a decrypt failure', async () => {
    const file = createBackup(PAYLOAD, PASS)
    const fromFuture = JSON.stringify({ ...file, version: file.version + 1 })
    const { effects } = spyEffects()

    // Must name the real problem — "wrong passphrase" here would send the user hunting for a
    // passphrase that was never wrong.
    await expect(restoreFromBackupFile(fromFuture, PASS, effects)).rejects.toThrow(/newer version/i)
    expect(effects.writeKeystore).not.toHaveBeenCalled()
  })
})

describe('changePassphrase — re-encrypting the keystore in place', () => {
  const NEW = 'a different passphrase entirely'

  it('re-encrypts so the keystore opens with the NEW passphrase and not the old', async () => {
    const store = encryptKeystore(KEYS, PASS)
    const { effects } = spyEffects()

    const entries = await changePassphrase(store, PASS, NEW, effects)
    expect(entries).toEqual(KEYS)

    const written = vi.mocked(effects.writeKeystore).mock.calls[0][0]
    expect(decryptKeystore(written, NEW)).toEqual(KEYS)
    // The old passphrase must genuinely stop working — otherwise "change" changed nothing.
    expect(() => decryptKeystore(written, PASS)).toThrow()
  })

  it('does NOT write when the current passphrase is wrong (verify before commit)', async () => {
    // The inverted-ordering failure: a typo in the "current passphrase" field must not be able
    // to replace a working keystore with one encrypted under a passphrase nobody intended.
    const store = encryptKeystore(KEYS, PASS)
    const { effects } = spyEffects()

    await expect(changePassphrase(store, WRONG, NEW, effects)).rejects.toThrow()
    expect(effects.writeKeystore).not.toHaveBeenCalled()
  })

  it('produces a fresh envelope rather than reusing the old salt/iv', async () => {
    // Reusing salt or iv across a passphrase change would leak that the plaintext is unchanged
    // and weaken the AEAD; encryptKeystore generates both per call, and this pins it.
    const store = encryptKeystore(KEYS, PASS)
    const { effects } = spyEffects()

    await changePassphrase(store, PASS, NEW, effects)
    const written = vi.mocked(effects.writeKeystore).mock.calls[0][0]

    expect(written.salt).not.toBe(store.salt)
    expect(written.iv).not.toBe(store.iv)
    expect(written.ct).not.toBe(store.ct)
  })

  it('preserves every key entry exactly', async () => {
    const store = encryptKeystore(KEYS, PASS)
    const { effects } = spyEffects()

    await changePassphrase(store, PASS, NEW, effects)
    const written = vi.mocked(effects.writeKeystore).mock.calls[0][0]
    const after = decryptKeystore(written, NEW)

    // Mnemonics are the whole point — a re-encrypt that dropped or reordered one would be
    // silent key loss discovered much later.
    expect(after.map((k) => k.mnemonic)).toEqual(KEYS.map((k) => k.mnemonic))
    expect(after.map((k) => k.id)).toEqual(KEYS.map((k) => k.id))
    expect(after.map((k) => k.label)).toEqual(KEYS.map((k) => k.label))
  })

  it('works on an empty keystore (no keys yet)', async () => {
    // A user who set a passphrase on first run and hasn't created a key is entitled to change
    // it; an empty-array edge case must not throw.
    const store = encryptKeystore([], PASS)
    const { effects } = spyEffects()

    const entries = await changePassphrase(store, PASS, NEW, effects)
    expect(entries).toEqual([])
    expect(effects.writeKeystore).toHaveBeenCalledOnce()
  })

  it('propagates a storage failure so the UI cannot report a false success', async () => {
    const store = encryptKeystore(KEYS, PASS)
    const { effects } = spyEffects()
    vi.mocked(effects.writeKeystore).mockRejectedValueOnce(new Error('disk full'))

    // The keystore still opens with the OLD passphrase in this case (nothing was replaced), so
    // the user must be told the change did not happen.
    await expect(changePassphrase(store, PASS, NEW, effects)).rejects.toThrow('disk full')
  })
})
