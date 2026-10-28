import { beforeEach, describe, expect, it } from 'vitest'
import {
  addVaultBackup,
  addMissingChangeDescriptor,
  readVaultBackups,
  removeVaultBackup,
  findVaultBackupByDescriptor,
  readVaultDraft,
  writeVaultDraft,
  clearVaultDraft,
  isDraftWorthKeeping,
  normalizeKeyLabels,
  parseDescriptorSummary,
  parseVaultBackupFile,
  renameVaultBackup,
  setVaultKeyLabel,
} from './vaults'
import { MAX_VAULTS } from './limits'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  clear() {
    this.m.clear()
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage()
})

describe('addMissingChangeDescriptor', () => {
  it('fills in a change descriptor on an entry that has none yet', () => {
    const entry = addVaultBackup('Eddie Treasury', 'wsh(sortedmulti(2,...))#abc123')
    expect(entry.changeDescriptor).toBeUndefined()

    const updated = addMissingChangeDescriptor(entry.id, 'wsh(sortedmulti(2,...))#def456')
    expect(updated.changeDescriptor).toBe('wsh(sortedmulti(2,...))#def456')

    const [stored] = readVaultBackups()
    expect(stored.changeDescriptor).toBe('wsh(sortedmulti(2,...))#def456')
  })

  it('refuses to overwrite an existing change descriptor', () => {
    const entry = addVaultBackup('Vault A', 'wsh(sortedmulti(2,...))#abc123', 'wsh(sortedmulti(2,...))#original')
    expect(() => addMissingChangeDescriptor(entry.id, 'wsh(sortedmulti(2,...))#replacement')).toThrow()

    const [stored] = readVaultBackups()
    expect(stored.changeDescriptor).toBe('wsh(sortedmulti(2,...))#original') // unchanged
  })

  it('throws for an unknown id', () => {
    expect(() => addMissingChangeDescriptor('does-not-exist', 'wsh(sortedmulti(2,...))#x')).toThrow()
  })

  it('does not affect other saved entries', () => {
    const a = addVaultBackup('Vault A', 'wsh(sortedmulti(2,...))#a')
    const b = addVaultBackup('Vault B', 'wsh(sortedmulti(2,...))#b')

    addMissingChangeDescriptor(a.id, 'wsh(sortedmulti(2,...))#a-change')

    const entries = readVaultBackups()
    expect(entries.find((v) => v.id === a.id)?.changeDescriptor).toBe('wsh(sortedmulti(2,...))#a-change')
    expect(entries.find((v) => v.id === b.id)?.changeDescriptor).toBeUndefined()
  })
})

/*
  Saving is ADDITIVE: the cache is a reference list, not a set. Re-saving a vault really does
  create a second row (user decision) — duplicates are made tellable apart by a label suffix
  rather than being silently refused, because a save that appears to do nothing reads as broken.
*/
describe('addVaultBackup — additive saves + label uniqueness', () => {
  const DESC = 'wsh(sortedmulti(2,[aaaaaaaa/48h/1h/0h/2h]tpubAAA/0/*,[bbbbbbbb/48h/1h/0h/2h]tpubBBB/0/*))#aaaaaaaa'

  it('re-saving the same descriptor DOES add a second entry', () => {
    const first = addVaultBackup('Family vault', DESC)
    const second = addVaultBackup('Family vault', DESC)

    expect(second.id).not.toBe(first.id)
    expect(readVaultBackups()).toHaveLength(2)
  })

  it('suffixes a colliding label so the two rows are nameable apart', () => {
    expect(addVaultBackup('Indy', DESC).label).toBe('Indy')
    expect(addVaultBackup('Indy', DESC).label).toBe('Indy (2)')
    expect(addVaultBackup('Indy', DESC).label).toBe('Indy (3)')
  })

  it('suffixes on the LABEL, so two DIFFERENT vaults sharing a name are also distinguished', () => {
    // This is the case that made a type-the-name delete confirmation ambiguous.
    addVaultBackup('Eddie Chase', 'wsh(sortedmulti(2,...))#one')
    const second = addVaultBackup('Eddie Chase', 'wsh(sortedmulti(2,...))#two')
    expect(second.label).toBe('Eddie Chase (2)')
    expect(new Set(readVaultBackups().map((v) => v.label)).size).toBe(2)
  })

  it('falls back to the default name, and uniquifies that too', () => {
    expect(addVaultBackup('   ', DESC).label).toBe('Vault')
    expect(addVaultBackup('', DESC).label).toBe('Vault (2)')
  })

  it('every save consumes capacity, including a duplicate', () => {
    const entries = Array.from({ length: MAX_VAULTS }, (_, i) => ({
      id: `id-${i}`,
      label: `V${i}`,
      descriptor: `wsh(sortedmulti(2,...))#c${i}`,
      savedAt: new Date().toISOString(),
    }))
    localStorage.setItem('signbit.vaults', JSON.stringify(entries))
    expect(() => addVaultBackup('V0', 'wsh(sortedmulti(2,...))#c0')).toThrow(/maximum/i)
  })

  it('findVaultBackupByDescriptor still reports whether a copy exists (drives the UI notice)', () => {
    addVaultBackup('Vault', DESC)
    expect(findVaultBackupByDescriptor(DESC)).toBeDefined()
    expect(findVaultBackupByDescriptor(`  ${DESC}  `)).toBeDefined()
    expect(findVaultBackupByDescriptor('')).toBeUndefined()
    expect(findVaultBackupByDescriptor('   ')).toBeUndefined()
  })
})

/*
  Descriptor parsing. The card renders a TRUNCATED xpub but offers the FULL one for copying,
  so the parser must carry both — a truncated value pasted into another tool is useless, and
  that failure is silent until someone tries to use it.
*/
describe('parseDescriptorSummary', () => {
  const XPUB1 = 'tpubDCBWBScQPGv4Xk3JSbhw6wYYpayMjb2eAYyArpbSqQTbLDpphHGAetB6VQgVeftLML8vDSUEWcC2xDi3qJJ3YCDChJDvqVzpgoYSuT52MhJ'
  const XPUB2 = 'tpubDD3ynpHgJQW8VvWWXPZS5EhMEA1SdEeZjJ6ffFQBTKuGZ6JLQCWvSSSGyEwHbLbAYPHTgYbBWHqrmzYgVQXFBZgUQrKKQKCXYQwbCbUeSpH'
  const DESC = `wsh(sortedmulti(2,[aaaaaaaa/48'/1'/0'/2']${XPUB1}/0/*,[BBBBBBBB/48'/1'/0'/2']${XPUB2}/0/*))#abcdefgh`

  it('keeps the FULL xpub alongside the truncated display form', () => {
    const parsed = parseDescriptorSummary(DESC)
    expect(parsed?.keys[0].xpub).toBe(XPUB1)
    expect(parsed?.keys[1].xpub).toBe(XPUB2)
    // The display form is genuinely shorter, so the two are not interchangeable.
    expect(parsed?.keys[0].xpubShort).not.toBe(XPUB1)
    expect(parsed!.keys[0].xpubShort.length).toBeLessThan(XPUB1.length)
  })

  it('reads the quorum, checksum and lowercases fingerprints', () => {
    const parsed = parseDescriptorSummary(DESC)
    expect(parsed?.threshold).toBe(2)
    expect(parsed?.total).toBe(2)
    expect(parsed?.checksum).toBe('abcdefgh')
    expect(parsed?.keys.map((k) => k.fingerprint)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
  })

  it('returns null for a descriptor it does not recognise, so callers show the raw text', () => {
    expect(parseDescriptorSummary('not a descriptor')).toBeNull()
    expect(parseDescriptorSummary('wsh(sortedmulti(2,garbage))#abcdefgh')).toBeNull()
  })
})

/*
  Cosigner names. Identity here is the FINGERPRINT, because canonicalKeyOrder sorts keys
  before the descriptor is built — a position-keyed map would attach one person's name to
  another person's key.
*/
describe('vault key labels', () => {
  const DESC = 'wsh(sortedmulti(2,...))#labels'

  it('stores cosigner names and reads them back', () => {
    const entry = addVaultBackup('Family', DESC, undefined, { aaaaaaaa: 'Alice', bbbbbbbb: 'Bob' })
    expect(entry.keyLabels).toEqual({ aaaaaaaa: 'Alice', bbbbbbbb: 'Bob' })
    expect(readVaultBackups()[0].keyLabels?.aaaaaaaa).toBe('Alice')
  })

  it('each saved copy carries its own names — one copy never rewrites another', () => {
    const first = addVaultBackup('Family', DESC, undefined, { aaaaaaaa: 'Alice' })
    const second = addVaultBackup('Family', DESC, undefined, { aaaaaaaa: 'Someone else' })

    expect(first.keyLabels).toEqual({ aaaaaaaa: 'Alice' })
    expect(second.keyLabels).toEqual({ aaaaaaaa: 'Someone else' })
    expect(readVaultBackups()[0].keyLabels).toEqual({ aaaaaaaa: 'Alice' }) // untouched
  })

  it('normalizes fingerprint case and trims names', () => {
    const entry = addVaultBackup('V', DESC, undefined, { AAAAAAAA: '  Alice  ' })
    expect(entry.keyLabels).toEqual({ aaaaaaaa: 'Alice' })
  })

  it('drops entries that are not an 8-hex fingerprint or not a non-empty string', () => {
    expect(normalizeKeyLabels({ notahex: 'Alice' })).toBeUndefined()
    expect(normalizeKeyLabels({ aaaaaaa: 'Alice' })).toBeUndefined() // 7 chars
    expect(normalizeKeyLabels({ aaaaaaaaa: 'Alice' })).toBeUndefined() // 9 chars
    expect(normalizeKeyLabels({ aaaaaaaa: '   ' })).toBeUndefined()
    expect(normalizeKeyLabels({ aaaaaaaa: 42 as unknown as string })).toBeUndefined()
    expect(normalizeKeyLabels({ aaaaaaaa: 'Alice', bad: 'Bob' })).toEqual({ aaaaaaaa: 'Alice' })
  })

  it('treats a non-object, an array, or an empty map as absent', () => {
    expect(normalizeKeyLabels(undefined)).toBeUndefined()
    expect(normalizeKeyLabels(null)).toBeUndefined()
    expect(normalizeKeyLabels('Alice')).toBeUndefined()
    expect(normalizeKeyLabels(['Alice'])).toBeUndefined()
    expect(normalizeKeyLabels({})).toBeUndefined()
  })

  it('coerces a malformed stored map on read rather than handing it back as-is', () => {
    localStorage.setItem(
      'signbit.vaults',
      JSON.stringify([
        { id: 'v1', label: 'V', descriptor: DESC, savedAt: '2026-01-01T00:00:00Z', keyLabels: { AAAAAAAA: 'Alice', nope: 'X' } },
      ]),
    )
    expect(readVaultBackups()[0].keyLabels).toEqual({ aaaaaaaa: 'Alice' })
  })

  it('leaves a vault saved without names untouched (older entries render as "Signer N")', () => {
    const entry = addVaultBackup('V', DESC)
    expect(entry.keyLabels).toBeUndefined()
    expect(readVaultBackups()[0].keyLabels).toBeUndefined()
  })
})

/*
  The platform's .txt backup file. Importing SAVES straight away, so whatever this returns is
  what lands in the cache — a mis-parse here is a wrong vault stored, not a form to correct.
*/
describe('parseVaultBackupFile', () => {
  const RECV = "wsh(sortedmulti(2,[aaaaaaaa/48'/1'/0'/2']tpubAAA/0/*,[bbbbbbbb/48'/1'/0'/2']tpubBBB/0/*))#recv1234"
  const CHANGE = "wsh(sortedmulti(2,[aaaaaaaa/48'/1'/0'/2']tpubAAA/1/*,[bbbbbbbb/48'/1'/0'/2']tpubBBB/1/*))#chng1234"

  it('reads the label and BOTH branches from the platform file format', () => {
    const file = `# Label: Family 2-of-3\n# Network: testnet\n\n${RECV}\n${CHANGE}\n`
    const parsed = parseVaultBackupFile(file)
    expect(parsed.label).toBe('Family 2-of-3')
    expect(parsed.descriptor).toBe(RECV)
    expect(parsed.changeDescriptor).toBe(CHANGE)
  })

  it('tells the branches apart by CHAIN, not by line order', () => {
    // Change first. Order must not decide which is which, or every derived address is wrong.
    const parsed = parseVaultBackupFile(`# Label: V\n\n${CHANGE}\n${RECV}\n`)
    expect(parsed.descriptor).toBe(RECV)
    expect(parsed.changeDescriptor).toBe(CHANGE)
  })

  it('handles a receive-only file, leaving the change descriptor unset', () => {
    const parsed = parseVaultBackupFile(`# Label: V\n\n${RECV}\n`)
    expect(parsed.descriptor).toBe(RECV)
    expect(parsed.changeDescriptor).toBeUndefined()
  })

  it('falls back to the first non-comment line for a bare/non-standard descriptor', () => {
    expect(parseVaultBackupFile('wsh(whatever)#zzz').descriptor).toBe('wsh(whatever)#zzz')
    const parsed = parseVaultBackupFile('# Label: V\n\nwsh(whatever)#zzz\n')
    expect(parsed.descriptor).toBe('wsh(whatever)#zzz')
    expect(parsed.changeDescriptor).toBeUndefined()
  })

  it('does not treat a mixed-chain descriptor as either branch', () => {
    const mixed = 'wsh(sortedmulti(2,[aaaaaaaa/48h]tpubAAA/0/*,[bbbbbbbb/48h]tpubBBB/1/*))#mixed123'
    const parsed = parseVaultBackupFile(`# Label: V\n\n${mixed}\n`)
    expect(parsed.descriptor).toBe(mixed) // falls back to first candidate
    expect(parsed.changeDescriptor).toBeUndefined()
  })
})

/*
  Legacy data repair + single-row deletes.

  The bug being pinned: ids used to fall back to a bare Date.now(), so two vaults saved in the
  same millisecond shared one — and removeVaultBackup filtered by id, deleting BOTH. Two
  separate properties are needed, and they pull in opposite directions: same DESCRIPTOR means
  one vault stored twice (collapse), same ID with DIFFERENT descriptors means two real vaults
  that collided (both must survive).
*/
describe('duplicate handling', () => {
  const A = 'wsh(sortedmulti(2,[aaaaaaaa/48h]tpubA/0/*))#aaaaaaaa'
  const B = 'wsh(sortedmulti(2,[bbbbbbbb/48h]tpubB/0/*))#bbbbbbbb'

  function seed(rows: unknown[]) {
    localStorage.setItem('signbit.vaults', JSON.stringify(rows))
  }

  it('removes exactly ONE row even when two entries share an id', () => {
    seed([
      { id: 'collided', label: 'Indy', descriptor: A, savedAt: 'x' },
      { id: 'collided', label: 'Treasury', descriptor: B, savedAt: 'x' },
    ])
    const before = readVaultBackups()
    expect(before).toHaveLength(2) // both survive the read — different vaults

    removeVaultBackup(before[0].id, before[0].descriptor)
    const after = readVaultBackups()
    expect(after).toHaveLength(1)
    expect(after[0].descriptor).toBe(B) // the OTHER vault is untouched
  })

  it('regenerates a collided id so the two rows become independently addressable', () => {
    seed([
      { id: 'collided', label: 'Indy', descriptor: A, savedAt: 'x' },
      { id: 'collided', label: 'Treasury', descriptor: B, savedAt: 'x' },
    ])
    const [first, second] = readVaultBackups()
    expect(first.id).not.toBe(second.id)
  })

  it('KEEPS two rows sharing a descriptor — the heal repairs ids, it never drops a vault', () => {
    seed([
      { id: 'one', label: 'Original name', descriptor: A, savedAt: 'x' },
      { id: 'two', label: 'Saved again later', descriptor: A, savedAt: 'y' },
    ])
    const entries = readVaultBackups()
    expect(entries).toHaveLength(2)
    expect(entries.map((v) => v.label)).toEqual(['Original name', 'Saved again later'])
  })

  it('drops rows with no descriptor rather than rendering a vault that is not one', () => {
    seed([{ id: 'one', label: 'Real', descriptor: A, savedAt: 'x' }, { id: 'two', label: 'Broken' }])
    const entries = readVaultBackups()
    expect(entries).toHaveLength(1)
    expect(entries[0].descriptor).toBe(A)
  })

  it('a read NEVER writes back — healing is in-memory only', () => {
    const raw = JSON.stringify([
      { id: 'collided', label: 'Indy', descriptor: A, savedAt: 'x' },
      { id: 'collided', label: 'Treasury', descriptor: B, savedAt: 'x' },
    ])
    seed(JSON.parse(raw))
    readVaultBackups()
    expect(localStorage.getItem('signbit.vaults')).toBe(raw)
  })

  it('removal falls back to the descriptor when the id no longer matches', () => {
    seed([{ id: 'stale-id', label: 'Indy', descriptor: A, savedAt: 'x' }])
    removeVaultBackup('an-id-that-was-regenerated', A)
    expect(readVaultBackups()).toHaveLength(0)
  })

  it('removing an unknown id with no descriptor is a no-op, not a wipe', () => {
    seed([{ id: 'one', label: 'Indy', descriptor: A, savedAt: 'x' }])
    removeVaultBackup('nope')
    expect(readVaultBackups()).toHaveLength(1)
  })

  it('newly added vaults get distinct ids even when saved in the same millisecond', () => {
    const a = addVaultBackup('A', A)
    const b = addVaultBackup('B', B)
    expect(a.id).not.toBe(b.id)
  })
})

describe('renameVaultBackup', () => {
  const DESC = 'wsh(sortedmulti(2,...))#rename'

  it('changes the label and nothing else', () => {
    const entry = addVaultBackup('Old name', DESC, 'wsh(...)#change', { aaaaaaaa: 'Alice' })
    const updated = renameVaultBackup(entry.id, 'New name')

    expect(updated.label).toBe('New name')
    expect(updated.id).toBe(entry.id)
    expect(updated.descriptor).toBe(entry.descriptor)
    expect(updated.changeDescriptor).toBe('wsh(...)#change')
    expect(updated.keyLabels).toEqual({ aaaaaaaa: 'Alice' })
    expect(readVaultBackups()[0].label).toBe('New name')
  })

  it('falls back to the default rather than storing a nameless vault', () => {
    const entry = addVaultBackup('Named', DESC)
    expect(renameVaultBackup(entry.id, '   ').label).toBe('Vault')
  })

  it('does not touch other entries, and throws for an unknown id', () => {
    const a = addVaultBackup('A', 'wsh(sortedmulti(2,...))#a')
    const b = addVaultBackup('B', 'wsh(sortedmulti(2,...))#b')
    renameVaultBackup(a.id, 'A renamed')

    const entries = readVaultBackups()
    expect(entries.find((v) => v.id === a.id)?.label).toBe('A renamed')
    expect(entries.find((v) => v.id === b.id)?.label).toBe('B')
    expect(() => renameVaultBackup('nope', 'X')).toThrow()
  })
})

describe('setVaultKeyLabel', () => {
  const DESC = 'wsh(sortedmulti(2,...))#signers'

  it('sets a cosigner name, and OVERWRITES an existing one (a correction, not an add)', () => {
    const entry = addVaultBackup('V', DESC, undefined, { aaaaaaaa: 'Alice' })
    const updated = setVaultKeyLabel(entry.id, 'aaaaaaaa', 'Alicia')
    expect(updated.keyLabels).toEqual({ aaaaaaaa: 'Alicia' })
  })

  it('adds a name without disturbing the others', () => {
    const entry = addVaultBackup('V', DESC, undefined, { aaaaaaaa: 'Alice' })
    const updated = setVaultKeyLabel(entry.id, 'bbbbbbbb', 'Bob')
    expect(updated.keyLabels).toEqual({ aaaaaaaa: 'Alice', bbbbbbbb: 'Bob' })
  })

  it('clearing REMOVES the entry so the row falls back to "Signer N", never an empty string', () => {
    const entry = addVaultBackup('V', DESC, undefined, { aaaaaaaa: 'Alice', bbbbbbbb: 'Bob' })
    const updated = setVaultKeyLabel(entry.id, 'aaaaaaaa', '  ')
    expect(updated.keyLabels).toEqual({ bbbbbbbb: 'Bob' })
    expect(updated.keyLabels).not.toHaveProperty('aaaaaaaa')
  })

  it('clearing the LAST name drops the map entirely rather than leaving an empty object', () => {
    const entry = addVaultBackup('V', DESC, undefined, { aaaaaaaa: 'Alice' })
    expect(setVaultKeyLabel(entry.id, 'aaaaaaaa', '').keyLabels).toBeUndefined()
  })

  it('normalizes fingerprint case and rejects a malformed one', () => {
    const entry = addVaultBackup('V', DESC)
    expect(setVaultKeyLabel(entry.id, 'AAAAAAAA', 'Alice').keyLabels).toEqual({ aaaaaaaa: 'Alice' })
    expect(() => setVaultKeyLabel(entry.id, 'nothex', 'X')).toThrow()
    expect(() => setVaultKeyLabel('unknown-id', 'aaaaaaaa', 'X')).toThrow()
  })
})

/*
  The offline builder's draft. The property that matters: transcribed keys survive leaving
  the screen, and a draft NEVER becomes a saved vault on its own.
*/
describe('vault builder draft', () => {
  const KEYS = [
    { id: 'r1', xpub: 'tpubAAA', fingerprint: 'aaaaaaaa', label: 'Alice' },
    { id: 'r2', xpub: 'tpubBBB', fingerprint: 'bbbbbbbb', label: 'Bob' },
  ]

  it('round-trips the in-progress keys, label, threshold and built descriptor', () => {
    writeVaultDraft({
      label: 'Family 2-of-3',
      threshold: 2,
      keys: KEYS,
      built: { receive: 'wsh(...)#r', change: 'wsh(...)#c' },
    })

    const draft = readVaultDraft()
    expect(draft?.label).toBe('Family 2-of-3')
    expect(draft?.threshold).toBe(2)
    expect(draft?.keys).toHaveLength(2)
    expect(draft?.keys[0].xpub).toBe('tpubAAA')
    expect(draft?.built?.receive).toBe('wsh(...)#r')
  })

  it('a draft is NEVER written into the saved-vault cache on its own', () => {
    writeVaultDraft({
      label: 'Not finished',
      threshold: 2,
      keys: KEYS,
      built: { receive: 'wsh(...)#valid', change: 'wsh(...)#validchange' },
    })
    // Even with a fully valid built descriptor sitting in the draft, the cache stays empty
    // until something explicitly calls addVaultBackup.
    expect(readVaultBackups()).toEqual([])
  })

  it('does not persist an untouched form, and clears an existing draft when emptied', () => {
    writeVaultDraft({ label: 'something', threshold: 2, keys: KEYS })
    expect(readVaultDraft()).not.toBeNull()

    writeVaultDraft({
      label: '',
      threshold: 2,
      keys: [{ id: 'r1', xpub: '', fingerprint: '', label: '' }],
    })
    expect(readVaultDraft()).toBeNull()
  })

  it('treats whitespace-only entries as nothing worth keeping', () => {
    expect(
      isDraftWorthKeeping({
        label: '   ',
        threshold: 2,
        keys: [{ id: 'r1', xpub: '  ', fingerprint: '', label: '' }],
        savedAt: '',
      }),
    ).toBe(false)
  })

  it('keeps a draft that has only a label, or only a fingerprint', () => {
    expect(isDraftWorthKeeping({ label: 'Family', threshold: 2, keys: [], savedAt: '' })).toBe(true)
    expect(
      isDraftWorthKeeping({
        label: '',
        threshold: 2,
        keys: [{ id: 'r1', xpub: '', fingerprint: 'aaaaaaaa', label: '' }],
        savedAt: '',
      }),
    ).toBe(true)
  })

  it('clearVaultDraft removes it', () => {
    writeVaultDraft({ label: 'x', threshold: 2, keys: KEYS })
    clearVaultDraft()
    expect(readVaultDraft()).toBeNull()
  })

  it('discards a malformed or older-shaped stored draft rather than returning holes', () => {
    localStorage.setItem('signbit.vault-draft', 'not json at all')
    expect(readVaultDraft()).toBeNull()

    localStorage.setItem('signbit.vault-draft', JSON.stringify({ label: 'x' })) // no keys array
    expect(readVaultDraft()).toBeNull()

    localStorage.setItem('signbit.vault-draft', JSON.stringify({ label: 'x', keys: [] }))
    expect(readVaultDraft()).toBeNull()
  })

  it('repairs a partially-shaped draft instead of dropping the keys it can read', () => {
    localStorage.setItem(
      'signbit.vault-draft',
      // threshold missing, one key missing its fingerprint field, built half-present
      JSON.stringify({ label: 'x', keys: [{ id: 'r1', xpub: 'tpubAAA' }], built: { receive: 'wsh(...)#r' } }),
    )
    const draft = readVaultDraft()
    expect(draft?.keys[0].xpub).toBe('tpubAAA')
    expect(draft?.keys[0].fingerprint).toBe('')
    expect(draft?.threshold).toBe(2) // sane default, not NaN
    expect(draft?.built).toBeUndefined() // an incomplete pair is no pair
  })
})
