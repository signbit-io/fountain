import { describe, it, expect } from 'vitest'
import {
  VAULT_SIZES,
  vaultSizeFor,
  keyInputProblem,
  minMajorityThreshold,
  isNoRedundancyQuorum,
  buildVaultDescriptor,
  canonicalKeyOrder,
  descriptorChecksumState,
  changeDescriptorFor,
  splitMultipath,
  toMultisigSlip132,
} from './build-descriptor'
import { readVaultInput, containsPrivateKey } from './vault-input'
import { formatVaultBackupFile, parseVaultBackupFile, vaultBackupFileName, fitRowsToSize, fitDraftToVaultSize } from './vaults'

/*
  The pieces behind the Vaults screen's fixed-size builder and its read-before-save paste form
  (2026-11-11). The keys and the golden pair are the ones build-descriptor.test.ts pins against
  the platform's own builder, so "the change descriptor worked out here equals the platform's"
  is checked against the platform's bytes, not against this module's own output.
*/
const KEY1 = { xpub: 'tpubDDwf2gdFxFahr9RUtDQCuZmsx34CfdZ7RALAirwC2FGeLBzW1TDiEpqFeRdxLdZD7rfsbZHYwSaT6CLM3TAcYRw6xfRv4U6KCQt4Zuhvjkz', fingerprint: '4ba43603' }
const KEY2 = { xpub: 'tpubDEXiq2SVhhqALktxfVFgj3C9M3T2G7xL11iezYg2LJAf245YkNyqp2K9TrvHABDCp2232k34UegU4aKEtUZNigit8EEqoLNe2JKMzMiLwYq', fingerprint: '8dfc9b34' }
const KEY3 = { xpub: 'tpubDEg3kqr2jo5ergkJbFqRHvCpiob7wR7Hi44J7y987G1JZfbzBND77XKTyPZzGvh3uyDf8kexMJnFD9W8FuraJ4wLMsx6YuZVXRSRRcx6QdD', fingerprint: '56c4fac3' }
const GOLDEN_RECEIVE =
  "wsh(sortedmulti(2,[4ba43603/48'/1'/0'/2']tpubDDwf2gdFxFahr9RUtDQCuZmsx34CfdZ7RALAirwC2FGeLBzW1TDiEpqFeRdxLdZD7rfsbZHYwSaT6CLM3TAcYRw6xfRv4U6KCQt4Zuhvjkz/0/*,[8dfc9b34/48'/1'/0'/2']tpubDEXiq2SVhhqALktxfVFgj3C9M3T2G7xL11iezYg2LJAf245YkNyqp2K9TrvHABDCp2232k34UegU4aKEtUZNigit8EEqoLNe2JKMzMiLwYq/0/*,[56c4fac3/48'/1'/0'/2']tpubDEg3kqr2jo5ergkJbFqRHvCpiob7wR7Hi44J7y987G1JZfbzBND77XKTyPZzGvh3uyDf8kexMJnFD9W8FuraJ4wLMsx6YuZVXRSRRcx6QdD/0/*))#lls4p9kd"
const GOLDEN_CHANGE =
  "wsh(sortedmulti(2,[4ba43603/48'/1'/0'/2']tpubDDwf2gdFxFahr9RUtDQCuZmsx34CfdZ7RALAirwC2FGeLBzW1TDiEpqFeRdxLdZD7rfsbZHYwSaT6CLM3TAcYRw6xfRv4U6KCQt4Zuhvjkz/1/*,[8dfc9b34/48'/1'/0'/2']tpubDEXiq2SVhhqALktxfVFgj3C9M3T2G7xL11iezYg2LJAf245YkNyqp2K9TrvHABDCp2232k34UegU4aKEtUZNigit8EEqoLNe2JKMzMiLwYq/1/*,[56c4fac3/48'/1'/0'/2']tpubDEg3kqr2jo5ergkJbFqRHvCpiob7wR7Hi44J7y987G1JZfbzBND77XKTyPZzGvh3uyDf8kexMJnFD9W8FuraJ4wLMsx6YuZVXRSRRcx6QdD/1/*))#62m0lrx9"
const FAKE_TPRV = 'tprv8ZgxMBicQKsPd9TeAdPADNnSyH9SSUUbTVeFszDE23Ki6TBB5nCefAdHkK8Fm3qMQR6sHwA56zqRmKmxnHk37JkiFzvncDqoKmPWubu7hDF'

describe('VAULT_SIZES, the builder’s fixed list', () => {
  it('is the platform’s list, in order', () => {
    expect(VAULT_SIZES.map((s) => `${s.m}/${s.n}`)).toEqual(['2/3', '3/5', '4/7', '5/9', '7/11', '8/15'])
  })
  it('every size is a strict majority with a spare key, so none can be refused or warned about', () => {
    for (const s of VAULT_SIZES) {
      expect(s.m).toBeGreaterThanOrEqual(minMajorityThreshold(s.n))
      expect(isNoRedundancyQuorum(s.m, s.n)).toBe(false)
    }
  })
})

describe('vaultSizeFor (restoring an older draft)', () => {
  it('keeps an exact match', () => {
    expect(vaultSizeFor(3, 5)).toEqual({ m: 3, n: 5 })
  })
  it('moves a size that is not on the list to the smallest one with room for every row', () => {
    expect(vaultSizeFor(2, 2)).toEqual({ m: 2, n: 3 })
    expect(vaultSizeFor(3, 4)).toEqual({ m: 3, n: 5 })
    expect(vaultSizeFor(2, 3)).toEqual({ m: 2, n: 3 })
    expect(vaultSizeFor(3, 3)).toEqual({ m: 2, n: 3 })
  })
  it('caps at the largest size', () => {
    expect(vaultSizeFor(9, 16)).toEqual({ m: 8, n: 15 })
  })
})

describe('keyInputProblem (one builder row)', () => {
  it('an empty row is not a problem, and a good key is fine', () => {
    expect(keyInputProblem('', '', 'testnet')).toBeNull()
    expect(keyInputProblem(KEY1.xpub, KEY1.fingerprint, 'testnet')).toBeNull()
    expect(keyInputProblem(toMultisigSlip132(KEY1.xpub, 'testnet'), '', 'testnet')).toBeNull()
  })
  it('names a pasted private key first', () => {
    expect(keyInputProblem(FAKE_TPRV, 'zz', 'testnet')).toBe('private_key')
  })
  it('names the wrong script type and the wrong network', () => {
    expect(keyInputProblem('Upub5' + 'a'.repeat(100), '', 'testnet')).toBe('wrapped')
    expect(keyInputProblem('vpub5' + 'a'.repeat(100), '', 'testnet')).toBe('single_sig')
    expect(keyInputProblem('xpub6' + 'a'.repeat(100), '', 'testnet')).toBe('other_network')
    expect(keyInputProblem(KEY1.xpub, '', 'mainnet')).toBe('other_network')
  })
  it('catches a mistyped key and a malformed fingerprint', () => {
    expect(keyInputProblem(KEY1.xpub.slice(0, -1) + 'A', '', 'testnet')).toBe('invalid')
    expect(keyInputProblem('hello', '', 'testnet')).toBe('invalid')
    expect(keyInputProblem(KEY1.xpub, '4ba4360', 'testnet')).toBe('bad_fingerprint')
    expect(keyInputProblem('', 'nothex!!', 'testnet')).toBe('bad_fingerprint')
  })
})

describe('descriptor text helpers', () => {
  it('reads the checksum state', () => {
    expect(descriptorChecksumState(GOLDEN_RECEIVE)).toBe('ok')
    expect(descriptorChecksumState(GOLDEN_RECEIVE.split('#')[0])).toBe('missing')
    expect(descriptorChecksumState(GOLDEN_RECEIVE.replace('sortedmulti(2', 'sortedmulti(3'))).toBe('wrong')
  })
  it('works out the change descriptor byte for byte as the platform builds it', () => {
    expect(changeDescriptorFor(GOLDEN_RECEIVE)).toBe(GOLDEN_CHANGE)
    expect(changeDescriptorFor(GOLDEN_CHANGE)).toBeNull()
  })
  it('splits a multipath descriptor into the same pair', () => {
    const multi = GOLDEN_RECEIVE.split('#')[0].replace(/\/0\/\*/g, '/<0;1>/*')
    expect(splitMultipath(multi)).toEqual({ receive: GOLDEN_RECEIVE, change: GOLDEN_CHANGE })
    expect(splitMultipath(GOLDEN_RECEIVE)).toBeNull()
  })
})

describe('readVaultInput (the paste form)', () => {
  it('reads a receive descriptor and fills in its change descriptor', () => {
    const r = readVaultInput(GOLDEN_RECEIVE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.descriptor).toBe(GOLDEN_RECEIVE)
    expect(r.value.changeDescriptor).toBe(GOLDEN_CHANGE)
    expect(r.value.changeSource).toBe('derived')
    expect(r.value.summary?.threshold).toBe(2)
    expect(r.value.summary?.total).toBe(3)
    expect(r.value.network).toBe('testnet')
    expect(r.value.firstAddress).toMatch(/^tb1q/)
    expect(r.value.checksumAdded).toBe(false)
  })
  it('joins a descriptor wrapped over several lines', () => {
    const wrapped = GOLDEN_RECEIVE.match(/.{1,60}/g)!.join('\n  ')
    const r = readVaultInput(wrapped)
    expect(r.ok && r.value.descriptor).toBe(GOLDEN_RECEIVE)
  })
  it('adds a missing checksum and says so', () => {
    const r = readVaultInput(GOLDEN_RECEIVE.split('#')[0])
    expect(r.ok && r.value.descriptor).toBe(GOLDEN_RECEIVE)
    expect(r.ok && r.value.checksumAdded).toBe(true)
  })
  it('refuses a changed character', () => {
    const typo = GOLDEN_RECEIVE.replace('[8dfc9b34', '[8dfc9b35')
    expect(readVaultInput(typo)).toEqual({ ok: false, problem: 'bad_checksum' })
  })
  it('reads a whole SignBit backup file, label included', () => {
    const file = formatVaultBackupFile({ label: 'Family', descriptor: GOLDEN_RECEIVE, changeDescriptor: GOLDEN_CHANGE })
    const r = readVaultInput(file)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.label).toBe('Family')
    expect(r.value.changeDescriptor).toBe(GOLDEN_CHANGE)
    expect(r.value.changeSource).toBe('given')
  })
  it('reads a multipath export', () => {
    const multi = GOLDEN_RECEIVE.split('#')[0].replace(/\/0\/\*/g, '/<0;1>/*')
    const r = readVaultInput(multi)
    expect(r.ok && r.value.descriptor).toBe(GOLDEN_RECEIVE)
    expect(r.ok && r.value.changeDescriptor).toBe(GOLDEN_CHANGE)
  })
  it('refuses a change descriptor from a different vault', () => {
    const other = buildVaultDescriptor({ m: 3, keys: canonicalKeyOrder([KEY1, KEY2, KEY3]), network: 'testnet' })
    expect(readVaultInput(GOLDEN_RECEIVE, other.change)).toEqual({ ok: false, problem: 'change_mismatch' })
    expect(readVaultInput(GOLDEN_RECEIVE, 'nonsense')).toEqual({ ok: false, problem: 'change_invalid' })
  })
  it('🚨 refuses any private key before reading anything else', () => {
    expect(containsPrivateKey(`wsh(sortedmulti(2,[4ba43603/48'/1'/0'/2']${FAKE_TPRV}/0/*))`)).toBe(true)
    expect(containsPrivateKey(GOLDEN_RECEIVE)).toBe(false)
    expect(readVaultInput(`wsh(sortedmulti(2,${FAKE_TPRV}/0/*))`)).toEqual({ ok: false, problem: 'private_key' })
    expect(readVaultInput(GOLDEN_RECEIVE, FAKE_TPRV)).toEqual({ ok: false, problem: 'private_key' })
  })
  it('says what is not a descriptor, and what is empty', () => {
    expect(readVaultInput('hello there')).toEqual({ ok: false, problem: 'not_a_descriptor' })
    expect(readVaultInput('   ')).toEqual({ ok: false, problem: 'empty' })
  })
})

describe('the backup file this app writes', () => {
  it('round-trips through the parser the import uses', () => {
    const text = formatVaultBackupFile({ label: 'Family\nvault', descriptor: GOLDEN_RECEIVE, changeDescriptor: GOLDEN_CHANGE })
    expect(text).toContain('# Policy: 2-of-3')
    expect(text).toContain('# Network: testnet')
    expect(parseVaultBackupFile(text)).toEqual({ label: 'Familyvault', descriptor: GOLDEN_RECEIVE, changeDescriptor: GOLDEN_CHANGE })
  })
  it('names the file safely', () => {
    expect(vaultBackupFileName('Family 3-of-5!')).toBe('signbit-vault-family-3-of-5.txt')
    expect(vaultBackupFileName('   ')).toBe('signbit-vault-vault.txt')
  })
})

describe('fitting builder rows to a size', () => {
  const row = (xpub: string, label = '') => ({ id: Math.random().toString(36).slice(2), xpub, fingerprint: '', label })
  it('keeps every row in use, in order, and pads with empty rows', () => {
    const rows = fitRowsToSize([row('a'), row(''), row('b')], 5)
    expect(rows.map((r) => r.xpub)).toEqual(['a', '', 'b', '', ''])
  })
  it('drops only EMPTY rows when shrinking', () => {
    const rows = fitRowsToSize([row('a'), row(''), row(''), row('b'), row('')], 3)
    expect(rows.map((r) => r.xpub)).toEqual(['a', '', 'b'])
  })
  it('a draft already on a listed size is left as it is', () => {
    const keys = [row('a'), row(''), row('')]
    expect(fitDraftToVaultSize({ threshold: 2, keys })).toEqual({ m: 2, n: 3, keys, resized: false })
  })
  it('an older 2-of-2 draft becomes a 2 of 3 with both keys kept', () => {
    const fitted = fitDraftToVaultSize({ threshold: 2, keys: [row('a'), row('b')] })
    expect([fitted.m, fitted.n, fitted.resized]).toEqual([2, 3, true])
    expect(fitted.keys.map((r) => r.xpub)).toEqual(['a', 'b', ''])
  })
  it('an older 4-key draft with a stray empty row becomes a 3 of 5, names kept', () => {
    const fitted = fitDraftToVaultSize({ threshold: 2, keys: [row('a'), row('', 'Bob'), row(''), row('c'), row('d')] })
    expect([fitted.m, fitted.n]).toEqual([3, 5])
    expect(fitted.keys.map((r) => r.xpub || r.label)).toEqual(['a', 'Bob', 'c', 'd', ''])
  })
})
