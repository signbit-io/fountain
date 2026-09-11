import { describe, it, expect } from 'vitest'
import { parseKeyFile, KEY_FILE_TYPE } from './key-file.js'
import { accountKey, generateKey } from './key.js'

/*
  The reader for an exported public-key envelope. Everything here is pure — no filesystem, no
  Tauri bridge — because the parser is where the refusals live and a refusal is only worth
  anything if it is exercised.

  ⚠️ Fixtures are DERIVED from a real mnemonic through accountKey(), not pasted. A hand-typed
  xpub that happens to fail its checksum would make every "accepts a good file" assertion pass
  for the wrong reason (the platform signer's own suite paid for exactly that trap with a
  fixture tpub that turned out to BE the key it was meant to differ from).
*/

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function envelope(net: 'testnet' | 'mainnet', overrides: Record<string, unknown> = {}): string {
  const pub = accountKey(MNEMONIC, net)
  return JSON.stringify({
    type: KEY_FILE_TYPE,
    version: 1,
    label: 'Alice',
    network: net,
    xpub: pub.tpub,
    fingerprint: pub.masterFingerprint,
    path: pub.derivationPath,
    ...overrides,
  })
}

describe('parseKeyFile — accepts a real exported envelope', () => {
  it('reads back the three builder fields from a testnet export', () => {
    const pub = accountKey(MNEMONIC, 'testnet')
    const res = parseKeyFile(envelope('testnet'))
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.key).toEqual({
      label: 'Alice',
      xpub: pub.tpub,
      fingerprint: pub.masterFingerprint,
      path: pub.derivationPath,
      network: 'testnet',
    })
  })

  it('reads a mainnet export at its own network', () => {
    const res = parseKeyFile(envelope('mainnet'))
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.key.network).toBe('mainnet')
    expect(res.key.xpub.startsWith('xpub')).toBe(true)
  })

  it('round-trips a freshly generated key (not just the golden mnemonic)', () => {
    const mnemonic = generateKey()
    const pub = accountKey(mnemonic, 'testnet')
    const text = JSON.stringify({
      type: KEY_FILE_TYPE,
      version: 1,
      label: 'Fresh',
      network: 'testnet',
      xpub: pub.tpub,
      fingerprint: pub.masterFingerprint,
      path: pub.derivationPath,
    })
    const res = parseKeyFile(text)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.key.xpub).toBe(pub.tpub)
  })

  it('tolerates a leading m/ on the path and an UPPERCASE fingerprint', () => {
    const pub = accountKey(MNEMONIC, 'testnet')
    const res = parseKeyFile(
      envelope('testnet', {
        path: `m/${pub.derivationPath}`,
        fingerprint: pub.masterFingerprint.toUpperCase(),
      }),
    )
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    // Normalized on the way in, so a builder row never renders a fingerprint in a case the
    // descriptor would not carry.
    expect(res.key.fingerprint).toBe(pub.masterFingerprint)
    expect(res.key.path).toBe(pub.derivationPath)
  })

  it('accepts a missing label — it is cosmetic, not identity', () => {
    const res = parseKeyFile(envelope('testnet', { label: undefined }))
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.key.label).toBe('')
  })

  it('accepts an absent fingerprint as the unknown placeholder', () => {
    const res = parseKeyFile(envelope('testnet', { fingerprint: undefined }))
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.key.fingerprint).toBe('00000000')
  })
})

/*
  🚨 THE REFUSAL THAT MATTERS MOST. The 24-word import is the only way key material may enter
  this app; a file is never allowed to be a second door. Each case below is a different shape
  the same accident takes.
*/
describe('parseKeyFile — refuses private material', () => {
  it('refuses an extended PRIVATE key in the xpub field', () => {
    const res = parseKeyFile(envelope('testnet', { xpub: 'tprv8ZgxMBicQKsPeDgjzdC36fs6bMjGApWDNLR9erAXMs5skhMv36j9MV5ecvfavji5khqjWaWSFhN3YcCUUdiKH6isR4Pwy3U5y5egddBr16m' }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('private_material')
  })

  it.each(['mnemonic', 'seed', 'seedPhrase', 'phrase', 'words', 'privateKey', 'privkey', 'secret', 'seed_phrase'])(
    'refuses a file carrying a "%s" field',
    (field) => {
      const res = parseKeyFile(envelope('testnet', { [field]: MNEMONIC }))
      expect(res.status).toBe('error')
      if (res.status !== 'error') return
      expect(res.code).toBe('private_material')
    },
  )

  it('refuses a secret hidden in a NESTED object', () => {
    const res = parseKeyFile(envelope('testnet', { extra: { backup: { mnemonic: MNEMONIC } } }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('private_material')
  })

  it('refuses a secret hidden in an ARRAY', () => {
    const res = parseKeyFile(envelope('testnet', { others: [{ xprv: 'tprv8Zgx' }] }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('private_material')
  })

  it('refuses an EMPTY secret field — the field itself is the tell', () => {
    const res = parseKeyFile(envelope('testnet', { mnemonic: '' }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('private_material')
  })

  /*
    ⚠️ Ordering: private material is refused BEFORE field validation, so a file that is BOTH
    malformed and carrying a seed is reported as the seed. The opposite order tells the user to
    fix a typo in a file they should be deleting.
  */
  it('reports private material even when the xpub is ALSO malformed', () => {
    const res = parseKeyFile(envelope('testnet', { xpub: 'not-a-key', mnemonic: MNEMONIC }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('private_material')
  })
})

describe('parseKeyFile — refuses a file that is not ours or not valid', () => {
  it('refuses text that is not JSON', () => {
    const res = parseKeyFile('cHNidP8BAHECAAAAAf...')
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('not_json')
  })

  it('refuses an empty file', () => {
    const res = parseKeyFile('')
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('not_json')
  })

  it.each(['null', '[]', '"a string"', '42'])('refuses the non-object JSON %s', (text) => {
    const res = parseKeyFile(text)
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('not_key_file')
  })

  it('refuses JSON with no type marker', () => {
    const res = parseKeyFile(envelope('testnet', { type: undefined }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('not_key_file')
  })

  it('refuses a foreign type marker', () => {
    const res = parseKeyFile(envelope('testnet', { type: 'some-other-wallet-key' }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('not_key_file')
  })

  it('refuses a missing xpub', () => {
    const res = parseKeyFile(envelope('testnet', { xpub: undefined }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('missing_field')
  })

  it('refuses a non-string xpub rather than coercing it', () => {
    const res = parseKeyFile(envelope('testnet', { xpub: 12345 }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('missing_field')
  })

  it('refuses a malformed fingerprint', () => {
    const res = parseKeyFile(envelope('testnet', { fingerprint: 'zzzz' }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('bad_fingerprint')
  })

  it('refuses an xpub that fails its checksum', () => {
    const pub = accountKey(MNEMONIC, 'testnet')
    // One character changed — the shape a hand-transcription error actually takes.
    const broken = pub.tpub.slice(0, -1) + (pub.tpub.endsWith('a') ? 'b' : 'a')
    const res = parseKeyFile(envelope('testnet', { xpub: broken }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('bad_xpub')
  })
})

/*
  ⚠️ THE POINT OF THE WHOLE MODULE: the file does not get to say what network it is on. Every
  case here has a `network` field that DISAGREES with the path, and the path wins every time.
*/
describe('parseKeyFile — network is RE-DERIVED from the path, never read from the file', () => {
  it('ignores a network field claiming mainnet on a coin-1 path', () => {
    const res = parseKeyFile(envelope('testnet', { network: 'mainnet' }))
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.key.network).toBe('testnet')
  })

  it('ignores a network field claiming testnet on a coin-0 path', () => {
    const res = parseKeyFile(envelope('mainnet', { network: 'testnet' }))
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.key.network).toBe('mainnet')
  })

  /*
    A mainnet xpub on a testnet path is not merely mislabelled — it cannot be validated at the
    network its own path declares, so it is refused as a bad key rather than silently accepted
    at whichever network happens to make it parse.
  */
  it('refuses a mainnet xpub sitting on a coin-1 path', () => {
    const mainnet = accountKey(MNEMONIC, 'mainnet')
    const testnet = accountKey(MNEMONIC, 'testnet')
    const res = parseKeyFile(envelope('testnet', { xpub: mainnet.tpub, path: testnet.derivationPath }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('bad_xpub')
  })

  it('refuses a missing path — it will not guess a network', () => {
    const res = parseKeyFile(envelope('testnet', { path: undefined }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('bad_path')
  })

  it('refuses a path whose coin type is not 0 or 1', () => {
    const res = parseKeyFile(envelope('testnet', { path: "48'/2'/0'/2'" }))
    expect(res.status).toBe('error')
    if (res.status !== 'error') return
    expect(res.code).toBe('bad_path')
  })

  it("accepts the h hardened marker as well as an apostrophe", () => {
    const res = parseKeyFile(envelope('testnet', { path: '48h/1h/0h/2h' }))
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.key.network).toBe('testnet')
  })
})
