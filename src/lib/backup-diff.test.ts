import { describe, it, expect } from 'vitest'
import { diffBackup, OVERWRITE_CONFIRM_WORD, type DeviceState } from './backup-diff'
import { generateKey, accountKey } from './key'
import { createBackup, readBackup, type BackupPayload } from './backup'
import type { KeyEntry } from './crypto'
import type { VaultBackup } from './vaults'
import type { AppSettings } from './activity'

/*
  Diff tests. The property that matters most is the one in the FIRST block: identity is the
  master fingerprint, NOT the local entry id. Get that wrong and the app tells a user that
  restoring their own backup will destroy the key they're restoring — the exact moment they
  most need to be told the truth.
*/

const NETWORK = 'testnet' as const

/** A key entry with a real mnemonic (so a real fingerprint derives) and a chosen local id. */
function keyEntry(id: string, label: string, mnemonic: string): KeyEntry {
  return { id, label, mnemonic, createdAt: '2026-01-01T00:00:00.000Z' }
}

function vault(label: string, descriptor: string, changeDescriptor?: string): VaultBackup {
  return { id: `v-${label}`, label, descriptor, changeDescriptor, savedAt: '2026-01-01T00:00:00.000Z' }
}

const SETTINGS: AppSettings = { autoLockMinutes: 5, theme: 'system', network: 'testnet' }

function device(over: Partial<DeviceState> = {}): DeviceState {
  return { keys: [], vaults: [], settings: SETTINGS, ...over }
}

function payload(over: Partial<BackupPayload> = {}): BackupPayload {
  return { keys: [], vaults: [], settings: SETTINGS, ...over }
}

describe('key identity is the fingerprint, not the local id', () => {
  it('treats the same mnemonic under DIFFERENT local ids as one unchanged key', () => {
    // The common real case: the same seed was imported on two devices, so each minted its own
    // random KeyEntry.id. An id-based diff would report 1 added + 1 removed and scream data
    // loss about a key that is present on both sides.
    const mnemonic = generateKey()
    const d = device({ keys: [keyEntry('device-local-id', 'My key', mnemonic)] })
    const b = payload({ keys: [keyEntry('a-totally-different-id', 'My key', mnemonic)] })

    const diff = diffBackup(d, b, NETWORK)

    expect(diff.keys).toHaveLength(1)
    expect(diff.keys[0].status).toBe('unchanged')
    expect(diff.totals.keysRemoved).toBe(0)
    expect(diff.destructive).toBe(false)
    expect(diff.identical).toBe(true)
  })

  it('reports the real master fingerprint as the identity', () => {
    const mnemonic = generateKey()
    const fp = accountKey(mnemonic, NETWORK).masterFingerprint.toLowerCase()
    const diff = diffBackup(device({ keys: [keyEntry('x', 'K', mnemonic)] }), payload(), NETWORK)
    expect(diff.keys[0].fingerprint).toBe(fp)
  })

  it('flags a relabelled key as changed, not as added+removed', () => {
    const mnemonic = generateKey()
    const diff = diffBackup(
      device({ keys: [keyEntry('a', 'Old name', mnemonic)] }),
      payload({ keys: [keyEntry('b', 'New name', mnemonic)] }),
      NETWORK,
    )
    expect(diff.keys).toHaveLength(1)
    expect(diff.keys[0]).toMatchObject({
      status: 'changed',
      labelChanged: true,
      deviceLabel: 'Old name',
      backupLabel: 'New name',
    })
    expect(diff.destructive).toBe(false)
  })
})

describe('a key\'s NETWORK STAMP is part of the comparison', () => {
  /*
    The fingerprint is IDENTICAL on testnet and mainnet (pinned in security.test.ts), so
    identity matching structurally cannot see a stamp difference. But the same seed derives a
    different account xpub per network — so importing a stamp change silently re-points an
    enrolled key at a different derivation. Without an explicit comparison the diff would call
    that pair 'unchanged' and the user would approve it blind.
  */
  it('flags the same seed stamped differently as CHANGED, not unchanged', () => {
    const mnemonic = generateKey()
    const diff = diffBackup(
      device({ keys: [{ ...keyEntry('a', 'My key', mnemonic), network: 'testnet' }] }),
      payload({ keys: [{ ...keyEntry('b', 'My key', mnemonic), network: 'mainnet' }] }),
      NETWORK,
    )
    expect(diff.keys).toHaveLength(1)
    expect(diff.keys[0]).toMatchObject({
      status: 'changed',
      networkChanged: true,
      deviceNetwork: 'testnet',
      backupNetwork: 'mainnet',
      labelChanged: false,
    })
    expect(diff.identical).toBe(false)
    // Not destructive — the seed survives; what changes is what it derives.
    expect(diff.destructive).toBe(false)
  })

  it('treats an UNSTAMPED key as testnet, so a pre-mainnet backup reads as unchanged', () => {
    // The common upgrade case: an old backup has no stamp and the device backfilled to testnet.
    // Reporting that as a change would cry wolf on every single legacy restore.
    const mnemonic = generateKey()
    const diff = diffBackup(
      device({ keys: [{ ...keyEntry('a', 'My key', mnemonic), network: 'testnet' }] }),
      payload({ keys: [keyEntry('b', 'My key', mnemonic)] }), // no stamp
      NETWORK,
    )
    expect(diff.keys[0].status).toBe('unchanged')
    expect(diff.identical).toBe(true)
  })

  it('reports a network difference in the SETTINGS diff too', () => {
    const diff = diffBackup(
      device({ settings: { autoLockMinutes: 5, theme: 'system', network: 'mainnet' } }),
      payload({ settings: { autoLockMinutes: 5, theme: 'system', network: 'testnet' } }),
      NETWORK,
    )
    expect(diff.settings).toEqual([{ key: 'network', deviceValue: 'mainnet', backupValue: 'testnet' }])
  })
})

describe('the destructive case — keys importing would permanently destroy', () => {
  it('marks a device-only key as removed and the whole diff as destructive', () => {
    const shared = generateKey()
    const deviceOnly = generateKey()
    const diff = diffBackup(
      device({ keys: [keyEntry('a', 'Shared', shared), keyEntry('b', 'Only here', deviceOnly)] }),
      payload({ keys: [keyEntry('c', 'Shared', shared)] }),
      NETWORK,
    )

    const removed = diff.keys.filter((k) => k.status === 'removed')
    expect(removed).toHaveLength(1)
    expect(removed[0].deviceLabel).toBe('Only here')
    expect(diff.totals.keysRemoved).toBe(1)
    expect(diff.destructive).toBe(true)
  })

  it('is NOT destructive when the backup merely adds keys', () => {
    const shared = generateKey()
    const extra = generateKey()
    const diff = diffBackup(
      device({ keys: [keyEntry('a', 'Shared', shared)] }),
      payload({ keys: [keyEntry('b', 'Shared', shared), keyEntry('c', 'New', extra)] }),
      NETWORK,
    )
    expect(diff.totals.keysAdded).toBe(1)
    expect(diff.totals.keysRemoved).toBe(0)
    expect(diff.destructive).toBe(false)
  })

  it('is NOT destructive when only a VAULT is dropped (a cache, not a seed)', () => {
    const diff = diffBackup(
      device({ vaults: [vault('Gone', 'wsh(sortedmulti(2,A,B,C))#aaa')] }),
      payload(),
      NETWORK,
    )
    expect(diff.totals.vaultsRemoved).toBe(1)
    expect(diff.destructive).toBe(false)
    expect(diff.identical).toBe(false)
  })

  it('lists removed keys FIRST so the danger is never buried under unchanged rows', () => {
    const gone = generateKey()
    const kept = [generateKey(), generateKey(), generateKey()]
    const deviceKeys = [
      ...kept.map((m, i) => keyEntry(`k${i}`, `Kept ${i}`, m)),
      keyEntry('gone', 'Doomed', gone),
    ]
    const diff = diffBackup(
      device({ keys: deviceKeys }),
      payload({ keys: kept.map((m, i) => keyEntry(`b${i}`, `Kept ${i}`, m)) }),
      NETWORK,
    )
    expect(diff.keys[0].status).toBe('removed')
    expect(diff.keys[0].deviceLabel).toBe('Doomed')
  })
})

describe('vault identity is the descriptor', () => {
  const DESC = 'wsh(sortedmulti(2,[aaaaaaaa/48h/1h/0h/2h]tpubA/0/*,[bbbbbbbb/48h/1h/0h/2h]tpubB/0/*))#abcdefgh'

  it('matches vaults across devices despite different local ids and whitespace', () => {
    const diff = diffBackup(
      device({ vaults: [{ ...vault('Family', DESC), id: 'local-1' }] }),
      payload({ vaults: [{ ...vault('Family', `  ${DESC}  `), id: 'local-2' }] }),
      NETWORK,
    )
    expect(diff.vaults).toHaveLength(1)
    expect(diff.vaults[0].status).toBe('unchanged')
  })

  it('flags a change descriptor the backup has and the device lacks', () => {
    const diff = diffBackup(
      device({ vaults: [vault('Family', DESC)] }),
      payload({ vaults: [vault('Family', DESC, 'wsh(sortedmulti(2,X/1/*,Y/1/*))#zzz')] }),
      NETWORK,
    )
    expect(diff.vaults[0]).toMatchObject({ status: 'changed', changeDescriptor: 'onlyBackup' })
  })

  it('flags two DIFFERENT change descriptors as a genuine conflict', () => {
    const diff = diffBackup(
      device({ vaults: [vault('Family', DESC, 'wsh(A)#one')] }),
      payload({ vaults: [vault('Family', DESC, 'wsh(B)#two')] }),
      NETWORK,
    )
    expect(diff.vaults[0].changeDescriptor).toBe('differs')
  })

  /*
    Cosigner names. Restore replaces the device's vault list wholesale, so a name difference
    is a rename Compare must surface — reporting "unchanged" would describe an outcome the
    user cannot see coming.
  */
  it('flags a vault whose ONLY difference is its cosigner names', () => {
    const withNames = (names: Record<string, string>): VaultBackup => ({
      ...vault('Family', DESC),
      keyLabels: names,
    })
    const diff = diffBackup(
      device({ vaults: [withNames({ aaaaaaaa: 'Alice' })] }),
      payload({ vaults: [withNames({ aaaaaaaa: 'Alicia' })] }),
      NETWORK,
    )
    expect(diff.vaults[0]).toMatchObject({ status: 'changed', keyLabels: 'differs' })
  })

  it('reports names the backup adds, and names only the device has', () => {
    const named: VaultBackup = { ...vault('Family', DESC), keyLabels: { aaaaaaaa: 'Alice' } }
    const plain = vault('Family', DESC)

    const adding = diffBackup(device({ vaults: [plain] }), payload({ vaults: [named] }), NETWORK)
    expect(adding.vaults[0]).toMatchObject({ status: 'changed', keyLabels: 'onlyBackup' })

    const losing = diffBackup(device({ vaults: [named] }), payload({ vaults: [plain] }), NETWORK)
    expect(losing.vaults[0]).toMatchObject({ status: 'changed', keyLabels: 'onlyDevice' })
  })

  it('is key-ORDER independent, so serialization order is never reported as a rename', () => {
    const a: VaultBackup = { ...vault('Family', DESC), keyLabels: { aaaaaaaa: 'Alice', bbbbbbbb: 'Bob' } }
    const b: VaultBackup = { ...vault('Family', DESC), keyLabels: { bbbbbbbb: 'Bob', aaaaaaaa: 'Alice' } }
    const diff = diffBackup(device({ vaults: [a] }), payload({ vaults: [b] }), NETWORK)
    expect(diff.vaults[0]).toMatchObject({ status: 'unchanged', keyLabels: 'same' })
  })

  it('treats an absent map and an empty map as the same thing', () => {
    const none = vault('Family', DESC)
    const empty: VaultBackup = { ...vault('Family', DESC), keyLabels: {} }
    const diff = diffBackup(device({ vaults: [none] }), payload({ vaults: [empty] }), NETWORK)
    expect(diff.vaults[0]).toMatchObject({ status: 'unchanged', keyLabels: 'same' })
  })

  it('does not merge two genuinely different vaults', () => {
    const diff = diffBackup(
      device({ vaults: [vault('A', 'wsh(one)#aaa')] }),
      payload({ vaults: [vault('B', 'wsh(two)#bbb')] }),
      NETWORK,
    )
    expect(diff.totals.vaultsRemoved).toBe(1)
    expect(diff.totals.vaultsAdded).toBe(1)
  })
})

describe('settings + locale', () => {
  it('reports differing prefs', () => {
    const diff = diffBackup(
      device({ settings: { autoLockMinutes: 5, theme: 'dark', network: 'testnet' }, locale: 'en' }),
      payload({ settings: { autoLockMinutes: 30, theme: 'light', network: 'testnet' }, locale: 'fr' }),
      NETWORK,
    )
    const keys = diff.settings.map((s) => s.key).sort()
    expect(keys).toEqual(['autoLockMinutes', 'locale', 'theme'])
    expect(diff.totals.settingsChanged).toBe(3)
  })

  it('reports NOTHING when the backup carries no settings (restore leaves prefs alone)', () => {
    // lib/restore.ts only writes settings `if (payload.settings)` — a backup without them has
    // no opinion, so claiming a difference would describe a write that never happens.
    const diff = diffBackup(
      device({ settings: { autoLockMinutes: 1, theme: 'dark', network: 'testnet' } }),
      { keys: [], vaults: [] },
      NETWORK,
    )
    expect(diff.settings).toEqual([])
    expect(diff.identical).toBe(true)
  })
})

describe('the diff is PASSPHRASE-BLIND', () => {
  /*
    The one axis on which two otherwise-identical backups genuinely differ — and the one the
    diff structurally CANNOT see, because it runs on the already-decrypted payload.

    Why this is worth pinning: change-passphrase makes the case routine rather than rare. A user
    who changes their passphrase and then compares an older backup is comparing a file encrypted
    under A against a device now on B. The honest answer is "these hold the same keys" — the
    passphrase is a property of the FILE, not of the keys inside it. The Compare screen therefore
    states the caveat in copy, since the diff can't.

    The risk this guards against is a future change to identity matching that folds anything
    envelope-derived (salt, iv, a KDF param, a passphrase-derived value) into key identity. That
    would make a passphrase difference look like a KEY difference — i.e. report `destructive` on
    a file whose seeds are byte-identical, at the exact moment the user is deciding whether it is
    safe to import. It must go through the real encrypt/decrypt round-trip: comparing two
    in-memory payloads would pass forever without ever touching a passphrase.
  */
  const PASS_A = 'the passphrase the backup was written under'
  const PASS_B = 'a different passphrase set later on this device'

  it('reports identical when the same keys are compared across DIFFERENT passphrases', () => {
    const mnemonic = generateKey()
    const keys = [keyEntry('device-id', 'Main key', mnemonic)]

    // Written under A — as an export taken before a passphrase change would have been.
    const file = JSON.stringify(createBackup(payload({ keys }), PASS_A))
    // Re-opened with A (the file keeps its own passphrase — changing the device's does not
    // reach into a file the user already stored elsewhere).
    const decrypted = readBackup(file, PASS_A)

    // The device is now on B, holding the very same seed.
    const diff = diffBackup(device({ keys }), decrypted, NETWORK)

    expect(diff.identical).toBe(true)
    expect(diff.destructive).toBe(false)
    expect(diff.totals.keysRemoved).toBe(0)
    expect(diff.keys[0].status).toBe('unchanged')
  })

  it('still detects a REAL key difference across different passphrases', () => {
    // The complement: passphrase-blindness must not blind it to actual key loss. Without this,
    // a diff that returned `identical` unconditionally would pass the test above.
    const shared = generateKey()
    const deviceOnly = generateKey()

    const file = JSON.stringify(createBackup(payload({ keys: [keyEntry('b', 'Shared', shared)] }), PASS_A))
    const decrypted = readBackup(file, PASS_A)

    const diff = diffBackup(
      device({ keys: [keyEntry('a', 'Shared', shared), keyEntry('c', 'Only here', deviceOnly)] }),
      decrypted,
      NETWORK,
    )

    expect(diff.identical).toBe(false)
    expect(diff.destructive).toBe(true)
    expect(diff.totals.keysRemoved).toBe(1)
  })

  it('carries no envelope material into the diff at all', () => {
    // Two backups of the SAME payload under different passphrases have different salt/iv/ct.
    // The diffs of each against the same device must be indistinguishable — if any envelope
    // value ever leaked into the comparison, these would diverge.
    const keys = [keyEntry('id', 'Main key', generateKey())]
    const underA = readBackup(JSON.stringify(createBackup(payload({ keys }), PASS_A)), PASS_A)
    const underB = readBackup(JSON.stringify(createBackup(payload({ keys }), PASS_B)), PASS_B)

    const d = device({ keys })
    expect(diffBackup(d, underA, NETWORK)).toEqual(diffBackup(d, underB, NETWORK))
  })
})

describe('robustness + purity', () => {
  it('keeps an underivable mnemonic visible in the diff rather than dropping it', () => {
    // A hand-edited or corrupt backup entry must not silently disappear from a comparison —
    // "this file contains something I can't read" is itself the finding.
    const diff = diffBackup(
      device(),
      payload({ keys: [keyEntry('broken', 'Corrupt entry', 'not a valid mnemonic at all')] }),
      NETWORK,
    )
    expect(diff.keys).toHaveLength(1)
    expect(diff.keys[0]).toMatchObject({ status: 'added', backupLabel: 'Corrupt entry' })
    expect(diff.keys[0].fingerprint).toBeUndefined()
  })

  it('never returns a mnemonic anywhere in the diff', () => {
    const mnemonic = generateKey()
    const diff = diffBackup(
      device({ keys: [keyEntry('a', 'Device', mnemonic)] }),
      payload({ keys: [keyEntry('b', 'Backup', generateKey())] }),
      NETWORK,
    )
    expect(JSON.stringify(diff)).not.toContain(mnemonic.split(' ')[0] + ' ' + mnemonic.split(' ')[1])
    expect(JSON.stringify(diff)).not.toContain(mnemonic)
  })

  it('does not mutate its inputs', () => {
    const d = device({ keys: [keyEntry('a', 'K', generateKey())], vaults: [vault('V', 'wsh(x)#a')] })
    const b = payload({ keys: [keyEntry('b', 'K2', generateKey())] })
    const dSnapshot = JSON.stringify(d)
    const bSnapshot = JSON.stringify(b)
    diffBackup(d, b, NETWORK)
    expect(JSON.stringify(d)).toBe(dSnapshot)
    expect(JSON.stringify(b)).toBe(bSnapshot)
  })

  it('reports an empty-vs-empty comparison as identical', () => {
    const diff = diffBackup(device(), payload(), NETWORK)
    expect(diff.identical).toBe(true)
    expect(diff.destructive).toBe(false)
  })

  it('pins the type-to-confirm word (a silent change would break the muscle memory gate)', () => {
    expect(OVERWRITE_CONFIRM_WORD).toBe('OVERWRITE')
  })
})
