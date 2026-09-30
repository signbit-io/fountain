import { describe, it, expect } from 'vitest'
import bs58check from 'bs58check'
import {
  buildVaultDescriptor,
  canonicalKeyOrder,
  toCanonicalXpub,
  toMultisigSlip132,
  normalizeXpub,
  BuildDescriptorError,
} from './build-descriptor.js'
import { parseKeyFile } from './key-file.js'

/*
  SLIP-132 extended-key encodings (Vpub on testnet/signet, Zpub on mainnet).

  🚨 **THE SAME DEFECT LIVED IN BOTH REPOS, BECAUSE THIS FILE'S SOURCE WAS WRITTEN TO MIRROR
  THE PLATFORM'S.** `PUBLIC_PREFIXES` listed `Vpub`/`Upub`/`Zpub`/`Ypub` and printed them back
  in the error text, while `bip32.fromBase58` was handed a network object that knows only the
  CANONICAL version bytes — so each of them died on "Invalid network version". Found
  2026-09-20. ⚠️ **A mirrored constant needs a mirrored test**, or the copy drifts silently.

  ⚠️ **THE ENCODER HERE IS DELIBERATELY NOT THE IMPLEMENTATION'S.** The version bytes are
  spelled out below, so the fixtures cannot agree with the code by construction.
*/

const VERSION = {
  Vpub: 0x02575483, // testnet/signet  native-SegWit MULTISIG
  Upub: 0x024289ef, // testnet/signet  wrapped-SegWit multisig
  vpub: 0x045f1cf6, // testnet/signet  native-SegWit SINGLE-SIG
  Zpub: 0x02aa7ed3, // mainnet         native-SegWit MULTISIG
  Ypub: 0x0295b43f, // mainnet         wrapped-SegWit multisig
  zpub: 0x04b24746, // mainnet         native-SegWit single-sig
} as const

/** Re-encode an extended key under different version bytes. The payload is untouched. */
function reVersion(extendedKey: string, version: number): string {
  const raw = Uint8Array.from(bs58check.decode(extendedKey))
  new DataView(raw.buffer).setUint32(0, version)
  return bs58check.encode(raw)
}

/*
  The SAME three keys and the SAME golden descriptor as build-descriptor.test.ts — repeated
  here on purpose. The point of this file is that the encoding cannot change the ANSWER, and
  the answer is that byte-identical string.
*/
const KEY1 = { xpub: 'tpubDDwf2gdFxFahr9RUtDQCuZmsx34CfdZ7RALAirwC2FGeLBzW1TDiEpqFeRdxLdZD7rfsbZHYwSaT6CLM3TAcYRw6xfRv4U6KCQt4Zuhvjkz', fingerprint: '4ba43603' }
const KEY2 = { xpub: 'tpubDEXiq2SVhhqALktxfVFgj3C9M3T2G7xL11iezYg2LJAf245YkNyqp2K9TrvHABDCp2232k34UegU4aKEtUZNigit8EEqoLNe2JKMzMiLwYq', fingerprint: '8dfc9b34' }
const KEY3 = { xpub: 'tpubDEg3kqr2jo5ergkJbFqRHvCpiob7wR7Hi44J7y987G1JZfbzBND77XKTyPZzGvh3uyDf8kexMJnFD9W8FuraJ4wLMsx6YuZVXRSRRcx6QdD', fingerprint: '56c4fac3' }

/** A real BIP-48 mainnet account key, for the Zpub side. */
const MAINNET_XPUB =
  'xpub6EVhhWcMVEYggeV7ZyPQj7rmajPmWwnaHsztipRHvfyNKqE1cHznJVEJ7mQL49Q2beFLMaEt8AYLRRPe5kba69c9TfXrgynCubUabG1Ygkj'

describe('toCanonicalXpub — the same key, re-encoded', () => {
  it('Vpub round-trips to the byte-identical tpub', () => {
    expect(toCanonicalXpub(reVersion(KEY1.xpub, VERSION.Vpub), 'testnet')).toBe(KEY1.xpub)
    expect(toCanonicalXpub(reVersion(KEY1.xpub, VERSION.Vpub), 'signet')).toBe(KEY1.xpub)
  })

  it('Zpub round-trips to the byte-identical xpub', () => {
    expect(toCanonicalXpub(reVersion(MAINNET_XPUB, VERSION.Zpub), 'mainnet')).toBe(MAINNET_XPUB)
  })

  it('🚨 changes ONLY the version bytes — depth, parent fp, index, chain code and pubkey survive', () => {
    /*
      🚨 **THE CATASTROPHIC FAILURE MODE IS A VALID KEY THAT IS A DIFFERENT KEY.** Rebuilding
      from the pubkey and chain code alone would drop depth, parent fingerprint and index. The
      result still parses and still derives the same addresses, so nothing looks wrong — but
      the ORIGIN in the descriptor no longer matches, and a cosigner's wallet finds no key to
      sign with, which is discovered only when a spend is finally attempted.
    */
    const before = bs58check.decode(KEY2.xpub)
    const after = bs58check.decode(toCanonicalXpub(reVersion(KEY2.xpub, VERSION.Vpub), 'testnet'))
    expect(after.length).toBe(78)
    expect(Buffer.from(after.slice(4)).toString('hex')).toBe(Buffer.from(before.slice(4)).toString('hex'))
  })

  it('leaves a canonical key alone, and tolerates pasted whitespace', () => {
    expect(toCanonicalXpub(KEY3.xpub, 'testnet')).toBe(KEY3.xpub)
    expect(toCanonicalXpub(`  ${KEY3.xpub}\n`, 'testnet')).toBe(KEY3.xpub)
  })
})

describe('🚨 the encoding cannot change the descriptor', () => {
  it('a 2-of-3 built from Vpubs is BYTE-IDENTICAL to the golden platform vector', () => {
    /*
      🚨 **THIS IS THE WHOLE CLAIM.** The descriptor is what a room full of keyholders reads
      aloud to confirm they built the same vault. If one person's wallet exported Vpubs and
      another's exported tpubs, two identical vaults would print two different strings — and
      the only sane conclusion in that room is that someone made a mistake.
    */
    const golden = buildVaultDescriptor({ m: 2, keys: [KEY1, KEY2, KEY3], network: 'testnet' })
    const asVpub = buildVaultDescriptor({
      m: 2,
      keys: [KEY1, KEY2, KEY3].map((k) => ({ ...k, xpub: reVersion(k.xpub, VERSION.Vpub) })),
      network: 'testnet',
    })
    expect(asVpub.receive).toBe(golden.receive)
    expect(asVpub.change).toBe(golden.change)
  })

  it('🚨 a MIXED key set — some Vpub, some tpub — still builds the same descriptor', () => {
    const golden = buildVaultDescriptor({ m: 2, keys: [KEY1, KEY2, KEY3], network: 'testnet' })
    const mixed = buildVaultDescriptor({
      m: 2,
      keys: [{ ...KEY1, xpub: reVersion(KEY1.xpub, VERSION.Vpub) }, KEY2, { ...KEY3, xpub: reVersion(KEY3.xpub, VERSION.Vpub) }],
      network: 'testnet',
    })
    expect(mixed.receive).toBe(golden.receive)
    expect(mixed.change).toBe(golden.change)
  })

  it('🚨 canonicalKeyOrder sorts on the xpub STRING, so normalising has to come first', () => {
    /*
      Pinned because it is the non-obvious half. `sortedmulti` sorts PUBKEYS at derivation, so
      a differently-ordered key list still derives identical addresses — the damage is confined
      to the descriptor TEXT, which is exactly the artifact this screen exists to compare.
    */
    const canonical = canonicalKeyOrder([KEY1, KEY2, KEY3]).map((k) => k.xpub)
    const reEncoded = canonicalKeyOrder(
      [KEY1, KEY2, KEY3].map((k) => ({ ...k, xpub: reVersion(k.xpub, VERSION.Vpub) })),
    ).map((k) => toCanonicalXpub(k.xpub, 'testnet'))
    expect(reEncoded).toEqual(canonical)
  })
})

describe('normalizeXpub — two encodings collapse to one string', () => {
  it('🚨 one key pasted twice, in two encodings, cannot become two cosigners', () => {
    /*
      🚨 A stated 2-of-3 whose two slots hold the SAME key is a real 1-of-2 — a silent
      downgrade of the vault's security that no screen can show.
    */
    expect(normalizeXpub(reVersion(KEY1.xpub, VERSION.Vpub), 'testnet')).toBe(normalizeXpub(KEY1.xpub, 'testnet'))
  })

  it('refuses a key from the other network', () => {
    expect(() => normalizeXpub(MAINNET_XPUB, 'testnet')).toThrow(BuildDescriptorError)
    expect(() => normalizeXpub(KEY1.xpub, 'mainnet')).toThrow(BuildDescriptorError)
    expect(() => normalizeXpub(reVersion(KEY1.xpub, VERSION.Vpub), 'mainnet')).toThrow(/Expected one of/)
  })

  it('refuses garbage, an empty value, and a truncated key', () => {
    expect(() => normalizeXpub('', 'testnet')).toThrow(BuildDescriptorError)
    expect(() => normalizeXpub('not-a-key', 'testnet')).toThrow(BuildDescriptorError)
    expect(() => normalizeXpub(reVersion(KEY1.xpub, VERSION.Vpub).slice(0, 60), 'testnet')).toThrow(BuildDescriptorError)
  })

  it('🚨 a damaged checksum is refused, never silently repaired', () => {
    const good = reVersion(KEY1.xpub, VERSION.Vpub)
    const bad = good.slice(0, 40) + (good[40] === 'a' ? 'b' : 'a') + good.slice(41)
    expect(bad).not.toBe(good)
    expect(() => normalizeXpub(bad, 'testnet')).toThrow(BuildDescriptorError)
  })
})

describe('refusals say what is actually wrong', () => {
  it('🚨 Upub/Ypub (WRAPPED SegWit) are refused with their own reason', () => {
    /*
      🚨 A wrapped-SegWit multisig key was derived at BIP-48 `…/1'`, not the `…/2'` these
      descriptors claim. Accepting one records an origin the exporting wallet never used:
      right addresses, wrong PSBT derivation hints, no signature when it matters.
    */
    expect(() => normalizeXpub(reVersion(KEY1.xpub, VERSION.Upub), 'testnet')).toThrow(/WRAPPED/i)
    expect(() => normalizeXpub(reVersion(MAINNET_XPUB, VERSION.Ypub), 'mainnet')).toThrow(/WRAPPED/i)
  })

  it('🚨 lowercase is a DIFFERENT SCRIPT TYPE, not a typo', () => {
    expect(() => normalizeXpub(reVersion(KEY1.xpub, VERSION.vpub), 'testnet')).toThrow(/SINGLE-SIGNATURE/i)
    expect(() => normalizeXpub(reVersion(MAINNET_XPUB, VERSION.zpub), 'mainnet')).toThrow(/SINGLE-SIGNATURE/i)
  })

  it('🚨 every SLIP-132 PRIVATE prefix is named as a private key, not as a wrong prefix', () => {
    /*
      ⚠️ `Uprv`/`Yprv`/`uprv`/`yprv` were MISSING from PRIVATE_PREFIXES until 2026-09-20, so
      pasting one produced "Expected one of tpub/Vpub" — which sends someone who has just
      exposed a private key looking for a typo instead of telling them what they did.
    */
    for (const version of [0x02575048 /* Vprv */, 0x024285b5 /* Uprv */]) {
      const priv = reVersion(
        // A private key payload is not needed: the PREFIX check runs on the text first.
        reVersion(KEY1.xpub, VERSION.Vpub),
        version,
      )
      expect(() => normalizeXpub(priv, 'testnet'), priv.slice(0, 4)).toThrow(/PRIVATE/i)
    }
  })
})

describe('key files carry the canonical form', () => {
  it('🚨 a key FILE holding a Vpub is accepted and stored as its tpub', () => {
    /*
      A key file is written by another copy of this app or by a wallet export, so it is exactly
      where a foreign encoding shows up. What we KEEP has to be canonical: the vault cache, the
      duplicate checks and the descriptor text all compare these as strings.
    */
    const file = {
      type: 'signbit-companion-key',
      version: 1,
      network: 'testnet',
      xpub: reVersion(KEY1.xpub, VERSION.Vpub),
      fingerprint: KEY1.fingerprint,
      path: "48'/1'/0'/2'",
      label: 'From Electrum',
    }
    const parsed = parseKeyFile(JSON.stringify(file))
    expect(parsed.status, JSON.stringify(parsed)).toBe('ok')
    if (parsed.status !== 'ok') return
    expect(parsed.key.xpub).toBe(KEY1.xpub)
  })

  it('a key file holding a single-sig vpub is refused with the single-sig reason', () => {
    const file = {
      type: 'signbit-companion-key',
      version: 1,
      network: 'testnet',
      xpub: reVersion(KEY1.xpub, VERSION.vpub),
      fingerprint: KEY1.fingerprint,
      path: "48'/1'/0'/2'",
    }
    const parsed = parseKeyFile(JSON.stringify(file))
    expect(parsed.status).toBe('error')
    if (parsed.status === 'error') expect(parsed.message).toMatch(/SINGLE-SIGNATURE/i)
  })
})

describe('toMultisigSlip132 — the display encoding for a wallet cosigner step', () => {
  it('tpub → the independently-encoded Vpub, and back to the same key', () => {
    const vpub = toMultisigSlip132(KEY1.xpub, 'testnet')
    expect(vpub).toBe(reVersion(KEY1.xpub, VERSION.Vpub))
    expect(toCanonicalXpub(vpub, 'testnet')).toBe(KEY1.xpub)
  })
  it('xpub → Zpub on mainnet', () => {
    expect(toMultisigSlip132(MAINNET_XPUB, 'mainnet')).toBe(reVersion(MAINNET_XPUB, VERSION.Zpub))
  })
})
