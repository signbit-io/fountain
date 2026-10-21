import { describe, it, expect } from 'vitest'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as descriptors from '@bitcoinerlab/descriptors'
import {
  generateKey,
  isValidMnemonic,
  accountKey,
  signApproval,
  classifyMessage,
  messageFields,
  signPsbt,
  analyzeMnemonic,
  findDuplicateMnemonic,
} from './key.js'
import type { NetworkName } from './bitcoin-network.js'

const TESTNET: NetworkName = 'testnet'
const { Output, Psbt } = descriptors
const net = descriptors.networks.testnet

describe('generateKey / isValidMnemonic', () => {
  it('generates a valid 24-word mnemonic', () => {
    const m = generateKey()
    expect(m.split(' ')).toHaveLength(24)
    expect(isValidMnemonic(m)).toBe(true)
  })

  it('rejects an invalid mnemonic', () => {
    expect(isValidMnemonic('not a real seed phrase at all nope')).toBe(false)
  })

  it('accepts mixed case / extra whitespace', () => {
    const m = generateKey().toUpperCase().replace(/ /g, '   ')
    expect(isValidMnemonic(m)).toBe(true)
  })
})

describe('accountKey export', () => {
  it('returns a testnet tpub, 8-hex fingerprint, and the BIP-48 path', () => {
    const k = accountKey(generateKey(), TESTNET)
    expect(k.tpub.startsWith('tpub')).toBe(true)
    expect(k.masterFingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(k.derivationPath).toBe("48'/1'/0'/2'")
  })

  it('derives at the mainnet coin type on mainnet', () => {
    const k = accountKey(generateKey(), 'mainnet')
    expect(k.derivationPath).toBe("48'/0'/0'/2'")
    expect(k.tpub.startsWith('xpub')).toBe(true)
  })
})

describe('signing paths', () => {
  it('signApproval works on mainnet', () => {
    // Mainnet is enabled in this build. The old blanket refusal is gone; the real network
    // invariant is the PSBT coin-type check pinned in security.test.ts.
    const payload = 'SIGNBIT-POLICY-CHANGE\nvault:x\nversion:1'
    expect(signApproval(generateKey(), 'mainnet', payload).length).toBeGreaterThan(0)
  })

  /*
    🚨 signApproval SIGNS ANY TEXT, and that is the fix rather than a regression.

    It used to be an ALLOWLIST of two hardcoded markers, so when the platform introduced a
    third (SIGNBIT-VAULT-IMPORT, for descriptor import) this app refused a payload the
    platform had just handed the user, calling it malformed. Every future message type would
    have broken identically, and a signer needing a release before it can sign a new message
    is a coordination problem dressed up as a security control.

    Refusing was never a security property: the signature is over a hash of the exact bytes
    on screen, so what protects the user is SEEING what they sign — which is what
    `classifyMessage` + the on-screen banner now do. Same trust model as the PSBT tab, where
    we decode and display rather than judge.
  */
  it('signApproval signs an UNRECOGNISED message rather than refusing it', () => {
    expect(signApproval(generateKey(), TESTNET, 'hello').length).toBeGreaterThan(0)
    // The case that actually broke: a marker newer than this build.
    const future = 'SIGNBIT-SOMETHING-NEW\nvault:x\nfield:y'
    expect(signApproval(generateKey(), TESTNET, future).length).toBeGreaterThan(0)
  })

  it('signApproval accepts every KNOWN SignBit message kind', () => {
    const payloads = [
      'SIGNBIT-POLICY-CHANGE\nvault:x\nversion:1',
      'SIGNBIT-KEY-HEALTHCHECK\nvault:x\nkey:y\nnonce:z',
      'SIGNBIT-VAULT-IMPORT\ndescriptor:abcd1234\nkey:11111111\nnonce:z',
      'SIGNBIT-OWNER-TRANSFER\nvault:x\nrequest:r\nto:u\nversion:v',
      'SIGNBIT-INHERITANCE-CLAIM\nvault:x\nrequest:r\nto:tb1qaddr\nversion:v\nnonce:n',
    ]
    for (const p of payloads) {
      expect(signApproval(generateKey(), TESTNET, p).length).toBeGreaterThan(0)
    }
  })

  it('🚨 signs the bytes it CHECKED — surrounding whitespace cannot change the signature', () => {
    /*
      The guards and `classifyMessage` both run on the TRIMMED text, so the signature must
      cover that same text. Hashing the raw input instead let a padded message display as a
      recognised policy change while committing to bytes the platform never canonicalises —
      the display-vs-signature divergence in its approval-tab form. The platform always
      verifies against the canonical payload it built itself, so trimmed is also the form
      that actually verifies.
    */
    const mnemonic = generateKey()
    const payload = 'SIGNBIT-POLICY-CHANGE\nvault:x\nversion:1'
    const clean = signApproval(mnemonic, TESTNET, payload)
    expect(signApproval(mnemonic, TESTNET, `  \n${payload}\n  `)).toBe(clean)
    expect(signApproval(mnemonic, TESTNET, `${payload}   `)).toBe(clean)
  })

  it('signApproval still refuses EMPTY input', () => {
    // Nothing to sign is a user error worth naming, unlike an unfamiliar message.
    expect(() => signApproval(generateKey(), TESTNET, '   ')).toThrow(/Paste the message first/)
  })

  it('classifyMessage recognises known markers ANCHORED, not as a substring', () => {
    /*
      Recognition must stay anchored even though signing no longer gates on it: every
      platform builder puts its marker at index 0, so a substring match would MISLABEL a
      message that merely contains those bytes — telling the user "this is a health check"
      about something that isn't one is worse than saying it is unrecognised.
    */
    expect(classifyMessage('SIGNBIT-POLICY-CHANGE\nvault:x')).toBe('policyChange')
    expect(classifyMessage('SIGNBIT-KEY-HEALTHCHECK\nvault:x')).toBe('healthCheck')
    expect(classifyMessage('SIGNBIT-VAULT-IMPORT\ndescriptor:x')).toBe('vaultImport')
    expect(classifyMessage('SIGNBIT-OWNER-TRANSFER\nvault:x')).toBe('ownerTransfer')
    // Whitespace is trimmed, not treated as a mismatch.
    expect(classifyMessage('  SIGNBIT-KEY-HEALTHCHECK\nvault:x\n')).toBe('healthCheck')
    // A marker buried mid-string is NOT that kind.
    expect(classifyMessage('note: SIGNBIT-KEY-HEALTHCHECK follows')).toBe('unknown')
    expect(classifyMessage('cHNidP8BSIGNBIT-POLICY-CHANGE')).toBe('unknown')
    // A SignBit-shaped marker this build does not know is distinguished from plain text,
    // so the banner can say "newer than this app" rather than "not a SignBit message".
    expect(classifyMessage('SIGNBIT-SOMETHING-NEW\nfield:y')).toBe('unknownSignbit')
    expect(classifyMessage('hello')).toBe('unknown')
  })

  /*
    Wrong-tab guards, both directions. The PSBT and Approval fields sit one tab apart and
    both take pasted text, so mixing them up is the mistake users actually make. Each error
    must NAME THE OTHER TAB — unguarded, an approval payload in the PSBT field surfaced the
    raw base64-decoder failure ("Failed to execute 'atob' on 'Window'…"), which names a
    browser API the user never invoked and tells them nothing about what to do next.
  */
  it('signPsbt rejects an approval payload by naming the Approval tab (not a raw atob error)', () => {
    for (const payload of ['SIGNBIT-POLICY-CHANGE\nvault:x\nversion:1', 'SIGNBIT-KEY-HEALTHCHECK\nvault:x\nkey:y\nnonce:z']) {
      expect(() => signPsbt(generateKey(), TESTNET, payload)).toThrow(/Approval tab/)
      expect(() => signPsbt(generateKey(), TESTNET, payload)).not.toThrow(/atob/)
    }
  })

  it('signPsbt reports other malformed input as an invalid PSBT, not a raw decoder error', () => {
    expect(() => signPsbt(generateKey(), TESTNET, 'obviously not a psbt')).toThrow(/Not a valid PSBT/)
  })

  it('signApproval rejects a PSBT by naming the PSBT tab', () => {
    expect(() => signApproval(generateKey(), TESTNET, 'cHNidP8BAAAA')).toThrow(/PSBT tab/)
  })
})

/*
  End-to-end 3-of-5 PSBT signing — the MVP's core proof. Build a 3-of-5 P2WSH vault from
  5 client-generated keys (mirrors a platform vault: n=5 keys, m=3 threshold), fund a fake
  UTXO at its receive address, build a spend PSBT, and sign with THREE of the five keys via
  signPsbt(). Assert the threshold is reached and the PSBT finalizes to a valid raw tx.
*/
describe('signPsbt — 3-of-5 threshold roundtrip', () => {
  it('reaches the 3-of-5 threshold and finalizes', () => {
    const M = 3
    const mnemonics = Array.from({ length: 5 }, () => generateKey())
    const keys = mnemonics.map((m) => accountKey(m, TESTNET))

    // Build the sortedmulti receive descriptor from the 5 exported keys (the platform's form).
    const exprs = keys.map((k) => `[${k.masterFingerprint}/${k.derivationPath}]${k.tpub}/0/*`)
    const body = `wsh(sortedmulti(${M},${exprs.join(',')}))`
    const descriptor = `${body}#${descriptors.checksum(body)}`

    // Receive address at index 0.
    const out0 = new Output({ descriptor, index: 0, network: net })
    const address = out0.getAddress()

    // Fake a prev-tx paying 100_000 sats to that address (segwit; witnessUtxo path).
    const bjs = descriptors.createBitcoinjsLib(ecc) as any
    const prev = new bjs.Transaction()
    prev.version = 2
    prev.addInput(Buffer.alloc(32, 1), 0)
    prev.addOutput(bjs.address.toOutputScript(address, net), BigInt(100_000))
    const prevHex = prev.toHex()

    // Build the spend PSBT: input = that UTXO, output = 90_000 to a fresh address (10k fee).
    const psbt = new Psbt({ network: net as never })
    out0.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    // Send to the index-1 address of the same descriptor (any valid script works for the test).
    const dest = new Output({ descriptor, index: 1, network: net }).getAddress()
    psbt.addOutput({ address: dest, value: BigInt(90_000) } as never)

    let b64 = psbt.toBase64()

    // Sign with keys 0, 2, 4 (three distinct keys) — order-independent.
    for (const i of [0, 2, 4]) {
      b64 = signPsbt(mnemonics[i], TESTNET, b64)
    }

    // Count valid sigs on the (single) input; must be exactly M=3.
    const signed = Psbt.fromBase64(b64, { network: net as never })
    const sigValidator = ((pubkey: Uint8Array, msghash: Uint8Array, signature: Uint8Array) =>
      ecc.verify(msghash, pubkey, signature)) as never
    const input = signed.data.inputs[0]
    expect(input.partialSig?.length).toBe(3)
    expect(signed.validateSignaturesOfInput(0, sigValidator)).toBe(true)

    // Finalizes to a valid raw tx (proves the 3-of-5 witness is complete).
    signed.finalizeAllInputs()
    const raw = signed.extractTransaction().toHex()
    expect(raw.length).toBeGreaterThan(0)
  })

  it('throws when the key is not part of the vault', () => {
    // A vault of 5 keys, but sign with a 6th unrelated key.
    const mnemonics = Array.from({ length: 5 }, () => generateKey())
    const keys = mnemonics.map((m) => accountKey(m, TESTNET))
    const exprs = keys.map((k) => `[${k.masterFingerprint}/${k.derivationPath}]${k.tpub}/0/*`)
    const body = `wsh(sortedmulti(3,${exprs.join(',')}))`
    const descriptor = `${body}#${descriptors.checksum(body)}`
    const out0 = new Output({ descriptor, index: 0, network: net })
    const address = out0.getAddress()
    const bjs = descriptors.createBitcoinjsLib(ecc) as any
    const prev = new bjs.Transaction()
    prev.version = 2
    prev.addInput(Buffer.alloc(32, 1), 0)
    prev.addOutput(bjs.address.toOutputScript(address, net), BigInt(100_000))
    const psbt = new Psbt({ network: net as never })
    out0.updatePsbtAsInput({ psbt, txHex: prev.toHex(), vout: 0 } as never)
    psbt.addOutput({ address, value: BigInt(90_000) } as never)

    const stranger = generateKey()
    expect(() => signPsbt(stranger, TESTNET, psbt.toBase64())).toThrow(/does not sign any part of this transaction/)
  })
})

/*
  ADVERSARIAL: malformed/truncated/garbage input to the signing paths must fail cleanly (throw)
  rather than crash the process or leak key material (mnemonic/private bytes) in the thrown
  error message. These are inputs an attacker or a corrupted transport (copy-paste, file import)
  could plausibly hand the signer.
*/
describe('signPsbt / signApproval — malformed input is rejected without leaking key material', () => {
  /*
    A FIXED mnemonic for the leak checks, deliberately not `generateKey()`.

    ⚠️ These tests used a random draw, which made them flaky for a reason that had nothing to do
    with what they assert. The guard scans an error message for mnemonic words, and the BIP-39
    wordlist contains ordinary English words that appear in ordinary library errors — `error`,
    `magic`, `number`, `valid`, `check`, `match`. bitcoinjs's "format error: invalid magic number"
    collides with several, so ~8% of runs failed with a message that reads like a key leak while
    being pure coincidence. (A word-boundary match, applied below, removes the substring half of
    that; it cannot remove the rest, because `error`/`magic`/`number` really are standalone words
    in that message AND really are BIP-39 words.)

    Determinism is the actual fix: the property under test is "no mnemonic word reaches the error
    message", which is not a statement about randomness. This is a real, checksum-valid BIP-39
    mnemonic screened so that none of its words appears in plausible library error text — so a
    failure here means a genuine leak, not a bad roll. It is a throwaway test vector generated
    for this file and controls nothing.
  */
  const LEAK_TEST_MNEMONIC =
    'about peanut latin human bus struggle bonus universe endless patrol tuition alpha ' +
    'alarm tribe mother stumble raise spoil ranch comic burst toy pupil involve'

  function assertNoKeyLeak(err: unknown, mnemonic: string) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const word of mnemonic.split(' ')) {
      // Skip trivially common short words that could coincidentally appear in a generic
      // library error message unrelated to the mnemonic itself.
      if (word.length <= 3) continue
      /*
        WORD-BOUNDARY match, not a substring one.

        ⚠️ This was `toContain`, which made the suite intermittently fail on a mnemonic it had
        no business objecting to: `generateKey()` draws random BIP-39 words, and the wordlist
        contains `valid`, `error`, `number`, `magic`, `input`, `index`, `master` (among others).
        The bitcoinjs error "format error: invalid magic number" therefore contains FOUR of them
        as substrings — so any draw including one of those words failed the test, roughly one run
        in four, with a message ("expected 'invalid magic number' not to contain 'valid'") that
        looks alarmingly like a real key leak while being nothing of the sort.

        The leak this guards against is a mnemonic WORD appearing in an error, which would always
        surface as a standalone token — so a boundary match detects it exactly as well while
        ignoring the coincidental substrings. Escaping isn't needed (BIP-39 words are [a-z] only).
      */
      expect(msg.toLowerCase()).not.toMatch(new RegExp(`\\b${word.toLowerCase()}\\b`))
    }
  }

  it('signPsbt throws (not crashes) on garbage base64', () => {
    const mnemonic = LEAK_TEST_MNEMONIC
    let threw: unknown
    try {
      signPsbt(mnemonic, TESTNET, 'not-a-valid-psbt-at-all')
    } catch (e) {
      threw = e
    }
    expect(threw).toBeDefined()
    assertNoKeyLeak(threw, mnemonic)
  })

  it('signPsbt throws on an empty string', () => {
    const mnemonic = generateKey()
    expect(() => signPsbt(mnemonic, TESTNET, '')).toThrow()
  })

  it('signPsbt throws on a truncated (valid-prefix, cut-off) PSBT', () => {
    const M = 3
    // The key we actually SIGN with is the fixed vector, so the leak assertion below scans for
    // words that were genuinely in play. The other four cosigners stay random — they only need
    // to be distinct, and none of them reaches the error message.
    const mnemonics = [LEAK_TEST_MNEMONIC, ...Array.from({ length: 4 }, () => generateKey())]
    const keys = mnemonics.map((m) => accountKey(m, TESTNET))
    const exprs = keys.map((k) => `[${k.masterFingerprint}/${k.derivationPath}]${k.tpub}/0/*`)
    const body = `wsh(sortedmulti(${M},${exprs.join(',')}))`
    const descriptor = `${body}#${descriptors.checksum(body)}`
    const out0 = new Output({ descriptor, index: 0, network: net })
    const address = out0.getAddress()
    const bjs = descriptors.createBitcoinjsLib(ecc) as any
    const prev = new bjs.Transaction()
    prev.version = 2
    prev.addInput(Buffer.alloc(32, 1), 0)
    prev.addOutput(bjs.address.toOutputScript(address, net), BigInt(100_000))
    const psbt = new Psbt({ network: net as never })
    out0.updatePsbtAsInput({ psbt, txHex: prev.toHex(), vout: 0 } as never)
    psbt.addOutput({ address, value: BigInt(90_000) } as never)
    const full = psbt.toBase64()
    const truncated = full.slice(0, Math.floor(full.length / 2))
    let threw: unknown
    try {
      signPsbt(mnemonics[0], TESTNET, truncated)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeDefined()
    // mnemonics[0] IS the fixed vector — we scan for the words of the key that actually signed.
    assertNoKeyLeak(threw, mnemonics[0])
  })

  it('signPsbt throws on a well-formed base64 blob that is not a PSBT at all', () => {
    const mnemonic = LEAK_TEST_MNEMONIC
    const notAPsbt = Buffer.from('hello world, this is definitely not a PSBT').toString('base64')
    let threw: unknown
    try {
      signPsbt(mnemonic, TESTNET, notAPsbt)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeDefined()
    assertNoKeyLeak(threw, mnemonic)
  })

  it('signApproval throws on an empty payload', () => {
    expect(() => signApproval(generateKey(), TESTNET, '')).toThrow()
  })

  it('signApproval throws (not crashes) with an invalid mnemonic passed through', () => {
    expect(() => signApproval('not a real mnemonic', TESTNET, 'SIGNBIT-POLICY-CHANGE\nx')).toThrow()
  })

  it('signPsbt throws (not crashes) with an invalid mnemonic passed through', () => {
    expect(() => signPsbt('not a real mnemonic', TESTNET, 'cHNidP8BAAAA')).toThrow()
  })
})

describe('analyzeMnemonic', () => {
  it('reports a fully valid phrase as ok', () => {
    const m = generateKey()
    const a = analyzeMnemonic(m)
    expect(a.ok).toBe(true)
    expect(a.count).toBe(24)
    expect(a.countValid).toBe(true)
    expect(a.checksumValid).toBe(true)
    expect(a.words.every((w) => w.ok)).toBe(true)
  })

  it('flags a word not in the BIP-39 wordlist', () => {
    const words = generateKey().split(' ')
    words[3] = 'notarealbip39word'
    const a = analyzeMnemonic(words.join(' '))
    expect(a.words[3]).toEqual({ word: 'notarealbip39word', ok: false })
    expect(a.words.filter((w) => !w.ok)).toHaveLength(1)
    expect(a.ok).toBe(false)
  })

  it('flags an invalid word count', () => {
    const a = analyzeMnemonic('abandon abandon abandon')
    expect(a.count).toBe(3)
    expect(a.countValid).toBe(false)
    expect(a.ok).toBe(false)
  })

  it('rejects a right-length phrase with a bad checksum', () => {
    // 24 valid wordlist words, but not a real BIP-39 checksum-valid phrase.
    const bad = Array(24).fill('abandon').join(' ')
    const a = analyzeMnemonic(bad)
    expect(a.countValid).toBe(true)
    expect(a.words.every((w) => w.ok)).toBe(true)
    expect(a.checksumValid).toBe(false)
    expect(a.ok).toBe(false)
  })

  it('handles empty input', () => {
    const a = analyzeMnemonic('')
    expect(a.count).toBe(0)
    expect(a.words).toEqual([])
    expect(a.ok).toBe(false)
  })

  it('normalizes case and whitespace like isValidMnemonic', () => {
    const m = generateKey()
    const messy = m.toUpperCase().replace(/ /g, '   ')
    expect(analyzeMnemonic(messy).ok).toBe(true)
  })

  /*
    ⚠️ The condition behind a REAL UI bug, pinned here so the fix can't be undone silently.

    BIP-39 allows 12/15/18/21/24 words, so someone typing a correct 24-word phrase passes
    THROUGH four other valid counts. At each one `countValid` is true, every word is a real
    BIP-39 word, and the checksum fails — which is indistinguishable, from analyzeMnemonic's
    output alone, from a genuinely scrambled phrase.

    SeedPhraseInput used to render that state as "all valid words, but the order looks wrong",
    turning every word chip orange FOUR TIMES while someone correctly typed their seed. On a
    recovery screen that reads as "your backup is broken".

    analyzeMnemonic is CORRECT here and deliberately unchanged — a partial phrase genuinely
    does fail its checksum. The fix is in the UI, which now only surfaces that failure at 24
    words (terminal — nothing can follow) or once typing has settled. This test documents why
    the component needs that gate: the ambiguity is real and cannot be resolved from a single
    snapshot of the analysis.
  */
  it('cannot distinguish a mid-typing prefix from a scrambled phrase (why the UI gates the warning)', () => {
    /*
      ⚠️ FIXED FIXTURE, not generateKey() — this test was FLAKY at ~12% and it was not the
      code's fault.

      A prefix of a valid 24-word mnemonic can itself be a VALID mnemonic by chance: a 12-word
      phrase carries only 4 checksum bits, so a random 24-word phrase's 12-word prefix passes
      its own checksum ~1 time in 16 (measured: 6.4% at 12 words, 3.1% / 1.8% / 0.8% at
      15/18/21). Across all four cut points that is a ~12% chance per run that some prefix is
      legitimately valid and the `checksumValid === false` assertion below fails — on correct
      code, with a different random seed each time.

      The property being pinned is about the UI's ambiguity, not about any particular seed, so
      a fixture that is KNOWN to fail at every cut point states it exactly. Randomness added no
      coverage here; it only added noise, which is worse than useless in a suite whose job is
      to be believed when it goes red. (Same reasoning, and the same fix, as
      LEAK_TEST_MNEMONIC above.)

      Screened so that all four prefixes have real BIP-39 words AND a failing checksum — the
      exact false-alarm state the UI gate exists for. Throwaway test vector, never a real key.
    */
    const PREFIXES_ALL_INVALID =
      'annual you initial rice episode slush nose road raven grain orbit season ' +
      'age cancel input float private then head plunge critic sunset daring festival'
    const full = PREFIXES_ALL_INVALID.split(' ')
    expect(isValidMnemonic(PREFIXES_ALL_INVALID)).toBe(true) // the fixture itself is a real seed
    expect(full).toHaveLength(24)

    for (const intermediate of [12, 15, 18, 21]) {
      const prefix = full.slice(0, intermediate).join(' ')
      const a = analyzeMnemonic(prefix)
      // Looks exactly like a "valid words, wrong order" phrase — the false-alarm state.
      expect(a.countValid).toBe(true)
      expect(a.words.every((w) => w.ok)).toBe(true)
      expect(a.checksumValid).toBe(false)
    }
  })
})

describe('findDuplicateMnemonic', () => {
  it('finds an entry whose mnemonic matches (normalized)', () => {
    const m = generateKey()
    const entries = [
      { id: '1', label: 'A', mnemonic: generateKey() },
      { id: '2', label: 'B', mnemonic: m },
    ]
    const dupe = findDuplicateMnemonic(entries, m.toUpperCase().replace(/ /g, '   '))
    expect(dupe?.id).toBe('2')
  })

  it('returns undefined when there is no match', () => {
    const entries = [{ id: '1', label: 'A', mnemonic: generateKey() }]
    expect(findDuplicateMnemonic(entries, generateKey())).toBeUndefined()
  })

  it('returns undefined for an empty entry list', () => {
    expect(findDuplicateMnemonic([], generateKey())).toBeUndefined()
  })
})

describe('the inheritance claim message', () => {
  const CLAIM = 'SIGNBIT-INHERITANCE-CLAIM\nvault:v1\nrequest:r1\nto:tb1qdestination\nversion:ks1\nnonce:n1'

  /*
    🚨 **RECOGNITION, NOT PERMISSION — it was ALREADY signable before it was recognised.**
    An unknown `SIGNBIT-` marker falls through to `unknownSignbit`, which signs. So this entry
    changes what the user is TOLD, and the value of that is specific here: this is the only
    canonical message whose effect is that coins move, and it was being labelled "a SignBit
    message this version doesn't recognise".
  */
  it('is recognised by name', () => {
    expect(classifyMessage(CLAIM)).toBe('inheritanceClaim')
  })

  it('was signable even before it was recognised, and still is', () => {
    expect(signApproval(generateKey(), TESTNET, CLAIM).length).toBeGreaterThan(0)
  })

  /*
    ⚠️ Anchored matching, the KNOWN_MESSAGES rule: the marker must be at index 0, so a
    payload that merely CONTAINS it is not one.
  */
  it('is not recognised when the marker is not at the start', () => {
    expect(classifyMessage('note\nSIGNBIT-INHERITANCE-CLAIM\nto:x')).toBe('unknown')
  })
})

describe('messageFields', () => {
  /*
    🚨 **THE DISPLAY-vs-SIGNATURE RULE, APPLIED TO MESSAGES** — the `psbt-decode` lesson of
    2026-09-10. The destination shown on screen is parsed from the same trimmed bytes
    `signApproval` hashes. If the two could diverge, the screen could name a different
    destination than the signature commits to, which is exactly the shape of the understated
    PSBT input that rendered an ordinary fee for a spend that burned ~1 BTC.
  */
  it('reads the destination the signature commits to', () => {
    const f = messageFields('SIGNBIT-INHERITANCE-CLAIM\nvault:v1\nto:tb1qdestination\nnonce:n')
    expect(f.to).toBe('tb1qdestination')
    expect(f.vault).toBe('v1')
  })

  it('parses padded text the same way, because signApproval hashes trimmed bytes', () => {
    expect(messageFields('\n  SIGNBIT-INHERITANCE-CLAIM\nto:tb1qdestination\n  ').to).toBe('tb1qdestination')
  })

  /*
    ⚠️ FIRST occurrence wins. A payload carrying `to:` twice is malformed, and taking the
    last would let a trailing line override the address a reader saw at the top of the screen.
  */
  it('takes the first occurrence of a repeated field', () => {
    expect(messageFields('SIGNBIT-INHERITANCE-CLAIM\nto:tb1qreal\nto:tb1qattacker').to).toBe('tb1qreal')
  })

  it('handles CRLF, so a payload pasted from Windows parses identically', () => {
    expect(messageFields('SIGNBIT-INHERITANCE-CLAIM\r\nto:tb1qaddr\r\n').to).toBe('tb1qaddr')
  })

  it('keeps everything after the FIRST colon', () => {
    expect(messageFields('X\nurl:https://example.com/a').url).toBe('https://example.com/a')
  })

  it('ignores lines that are not fields, and never throws', () => {
    expect(() => messageFields('')).not.toThrow()
    const f = messageFields('SIGNBIT-INHERITANCE-CLAIM\njust a line\nto:tb1qaddr')
    expect(f.to).toBe('tb1qaddr')
    expect(Object.keys(f)).not.toContain('just a line')
  })

  /*
    ⚠️ Display only, never a gate: a payload with no `to:` returns nothing for it and the
    screen simply shows no destination panel. It must not throw and must not block signing.
  */
  it('returns nothing for a missing field rather than failing', () => {
    expect(messageFields('SIGNBIT-INHERITANCE-CLAIM\nvault:v1').to).toBeUndefined()
  })
})
