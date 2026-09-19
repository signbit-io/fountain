import * as ecc from '@bitcoinerlab/secp256k1'
import { BIP32Factory } from 'bip32'
import * as descriptors from '@bitcoinerlab/descriptors'
import { bitcoinNetwork, multisigAccountPath, type NetworkName } from './bitcoin-network.js'

/*
  Offline vault descriptor construction — the "coparties in a room together" scenario:
  given every keyholder's PUBLIC key (xpub + fingerprint, including the platform's — see
  the note below), build the exact same wsh(sortedmulti(m,...))#checksum descriptor the
  SignBit platform would build server-side, entirely offline. No platform involvement needed to
  originate a vault; the resulting descriptor works standalone in any third-party multisig tool
  (Sparrow, etc.) for verifying addresses and building/signing/broadcasting spends.

  This is a PORT of the platform's descriptor builder — same algorithm (BIP-67 sort via
  sortedmulti, same key-expression shape, same checksum function), pinned by
  build-descriptor.drift.test.ts against the platform's copy so silent divergence fails CI
  (the same drift-guard discipline the platform signer uses for its policy copy).

  The platform's xpub isn't secret — it's meant to be embedded in every descriptor it's
  part of, so once ANY keyholder has seen it once (e.g. cached from a previous vault via
  lib/vaults.ts), it can be reused here for a brand-new vault with zero live API call.
*/

const bip32 = BIP32Factory(ecc)

// Version-byte prefixes accepted per network for an EXTENDED PUBLIC key — mirrors
// the platform's accepted public-key prefixes exactly.
const PUBLIC_PREFIXES: Record<NetworkName, string[]> = {
  testnet: ['tpub', 'Vpub', 'Upub'],
  signet: ['tpub', 'Vpub', 'Upub'],
  mainnet: ['xpub', 'Zpub', 'Ypub'],
}
/* Exported so lib/key-file.ts can refuse an imported file carrying private material against
   the SAME list this module validates against — two copies of "what looks private" is exactly
   how one of them comes to be missing a prefix. */
export const PRIVATE_PREFIXES = ['xprv', 'tprv', 'zprv', 'vprv', 'Zprv', 'Vprv']

export class BuildDescriptorError extends Error {}

export type DescriptorKeyInput = {
  /** Extended PUBLIC key (tpub on testnet). Never a private key. */
  xpub: string
  /** 8-hex master fingerprint, or '00000000' if unknown. */
  fingerprint: string
  /** Origin path WITHOUT the leading m/, e.g. "48'/1'/0'/2'". Defaults to the standard. */
  path?: string
}

/** Validate an extended PUBLIC key for the given network. Throws BuildDescriptorError. */
export function validateXpub(value: string, net: NetworkName): void {
  const v = value.trim()
  if (!v) throw new BuildDescriptorError('Missing extended public key')
  if (PRIVATE_PREFIXES.some((p) => v.startsWith(p))) {
    throw new BuildDescriptorError('That is a PRIVATE key. Never paste a private key here. Use the xpub or tpub instead.')
  }
  const allowed = PUBLIC_PREFIXES[net]
  if (!allowed.some((p) => v.startsWith(p))) {
    throw new BuildDescriptorError(`Expected one of ${allowed.join('/')} for ${net}`)
  }
  try {
    const node = bip32.fromBase58(v, bitcoinNetwork(net))
    if (node.privateKey) throw new BuildDescriptorError('Key unexpectedly contains private material')
  } catch (err) {
    if (err instanceof BuildDescriptorError) throw err
    throw new BuildDescriptorError('Invalid extended public key (parse/checksum/network mismatch)')
  }
}

const FINGERPRINT_RE = /^[0-9a-fA-F]{8}$/
export function normalizeFingerprint(fp: string): string {
  const v = (fp || '').trim().toLowerCase()
  if (!v) return '00000000'
  if (!FINGERPRINT_RE.test(v)) throw new BuildDescriptorError('Fingerprint must be 8 hex characters')
  return v
}

/** Build the key expression `[fp/path]xpub/<chain>/*` for use inside a descriptor. */
function keyExpression(key: DescriptorKeyInput, chain: 0 | 1, net: NetworkName): string {
  const fp = normalizeFingerprint(key.fingerprint)
  const path = (key.path ?? multisigAccountPath(net)).replace(/^m\//, '')
  return `[${fp}/${path}]${key.xpub.trim()}/${chain}/*`
}

export type BuiltDescriptors = {
  /** Receive-branch descriptor with checksum, e.g. wsh(sortedmulti(2,...))#cs */
  receive: string
  /** Change-branch descriptor with checksum. */
  change: string
}

/**
 * ⚠️ IMPORTANT (verified against the platform's own descriptor builder, not assumed): the
 * "sortedmulti" name refers to BIP-67 sorting inside the SIGNING/witness-script logic —
 * sortedmulti is functionally order-independent for spending — but the DESCRIPTOR TEXT
 * (and therefore its checksum) preserves whatever order `keys` is passed in; it is NOT
 * reordered. Two people building "the same vault" from the same key set but a different
 * entry order get two descriptors that are functionally equivalent but textually
 * different. For the offline "coparties in a room" flow, ALWAYS pass keys through
 * canonicalKeyOrder() first so any group converges on the identical descriptor
 * regardless of who typed their key in first — see that function's own doc.
 */
export function canonicalKeyOrder<T extends { xpub: string; fingerprint?: string }>(keys: T[]): T[] {
  return [...keys].sort((a, b) => {
    const fpCompare = normalizeFingerprint(a.fingerprint ?? '').localeCompare(normalizeFingerprint(b.fingerprint ?? ''))
    return fpCompare !== 0 ? fpCompare : a.xpub.localeCompare(b.xpub)
  })
}

/**
 * The smallest `m` that is a STRICT MAJORITY of `n` — `floor(n / 2) + 1`.
 *
 * 🔒 A MINIMUM, not a default — and that distinction is the whole reason this is a separate
 * function from defaultThreshold() below, which returns the identical number and means
 * something else entirely. This one is ENFORCED (buildVaultDescriptor refuses below it); that
 * one is a starting suggestion the user is free to raise. Collapsing them would put "a
 * default, never a rule" in the doc comment of the function that IS the rule.
 *
 * ⚠️ STRICT majority (`m > n/2`), not "half or better". On an even `n` the weaker form
 * admits an exact split: a 3-of-6 lets two disjoint groups of three each spend without the
 * other, so the vault has two independent owners while presenting itself as one.
 *
 * ⚠️ Deliberately identical to the SignBit platform's importer rule of the same name, so a
 * vault this app agrees to BUILD is a shape that platform agrees to ADOPT. There is no
 * build-time link between the two repos — this is compatibility by convention, held by tests.
 */
export function minMajorityThreshold(n: number): number {
  return Math.floor(n / 2) + 1
}

/**
 * The threshold a vault of `n` keys should START at — a simple majority.
 *
 * 2-of-3, 3-of-5, 4-of-7: the standard collaborative-custody shape, where the vault
 * survives losing any single key while still needing more than one to spend.
 *
 * ⚠️ A DEFAULT, never a rule. `m` is a real security choice and stays editable: 2-of-3 and
 * 3-of-3 are both legitimate and mean very different things (one survives a lost key, the
 * other does not), so deriving it silently would pick someone's security model for them.
 * What this replaces is a hardcoded `2`, which never moved as keys were added — quietly
 * making 2-of-5 the default for a 5-key vault.
 *
 * The default is also the FLOOR (it returns minMajorityThreshold): `m` stays editable
 * UPWARD only, so an untouched form is always a shape buildVaultDescriptor will accept.
 */
export function defaultThreshold(keyCount: number): number {
  // Not redundant with minMajorityThreshold(1) === 1: this guards keyCount === 0, which is
  // the build form's own initial state before any key is entered.
  if (keyCount <= 1) return 1
  return minMajorityThreshold(keyCount)
}

/**
 * Does this quorum leave NO redundancy? (`m === n`, e.g. 3-of-3.)
 *
 * ⚠️ Worth warning about, never blocking: it is a valid vault and occasionally what someone
 * genuinely wants, but losing ANY single key makes the funds permanently unspendable —
 * there is no spare. That is the one property people most often do not realise they chose.
 */
export function isNoRedundancyQuorum(m: number, n: number): boolean {
  return n > 1 && m === n
}

/**
 * Build the receive + change descriptors for an m-of-n P2WSH multisig from every
 * keyholder's public key (INCLUDING the platform's, if this vault will ever sync to
 * the platform — but nothing here requires that; it works for any n keys). Keys are used in
 * the EXACT order given — see canonicalKeyOrder() above for why the caller must sort
 * first if convergence across independently-built descriptors matters.
 */
export function buildVaultDescriptor(params: {
  m: number
  keys: DescriptorKeyInput[]
  network: NetworkName
}): BuiltDescriptors {
  const { m, keys, network } = params
  const n = keys.length
  if (m < 1 || m > n) throw new BuildDescriptorError(`Invalid policy: ${m}-of-${n}`)
  keys.forEach((k) => validateXpub(k.xpub, network))

  /*
    🔒 POLICY REFUSAL — CHECKED LAST, AFTER EVERY STRUCTURAL AND KEY-LEVEL CHECK ABOVE.

    Everything above refuses a descriptor that CANNOT exist. This refuses one that can: the
    keys are valid and the policy is constructible, but the vault would let a MINORITY of its
    own keyholders spend without the rest — which is not the vault its key count claims it is.
    2-of-5, 3-of-6 and 3-of-8 are all refused.

    ⚠️ THE ONE PLACE THIS LIBRARY BLOCKS RATHER THAN WARNS (user decision, 2026-08-21), and
    it is deliberately narrow. `m === n` stays a WARNING (isNoRedundancyQuorum) because losing
    your only spare is a real trade someone can mean. A minority quorum is not a trade anyone
    means: nobody sets out to let any 2 of 5 keyholders move the money alone.

    ⚠️ ORDERED LAST DELIBERATELY. A policy refusal ahead of a validity check reports the
    wrong error and sends the user to fix the wrong thing — a key set with a malformed xpub
    AND a sub-majority m must hear about the malformed xpub. (The SignBit platform's importer
    paid for that lesson three times and orders its own refusals the same way.) Pinned by a
    test in build-descriptor.test.ts.
  */
  const required = minMajorityThreshold(n)
  if (m < required) {
    throw new BuildDescriptorError(
      `Refusing to build a ${m}-of-${n} vault: any ${m} of the ${n} keyholders could move the funds without the others. A vault needs a majority to spend — use at least ${required} of ${n}.`,
    )
  }

  const make = (chain: 0 | 1) => {
    const inner = `sortedmulti(${m},${keys.map((k) => keyExpression(k, chain, network)).join(',')})`
    const body = `wsh(${inner})`
    const checksum = descriptors.checksum(body)
    return `${body}#${checksum}`
  }

  return { receive: make(0), change: make(1) }
}

/**
 * Derive the actual Bitcoin address at a given index of a receive/change descriptor —
 * entirely offline, from public data only. Port of the platform's deriveAddress
 * (same `descriptors.Output` call). Lets a keyholder independently verify an
 * address the platform shows them (or reconstruct one for a third-party tool) without any
 * network call — the "verify, don't trust" property this whole cache exists for.
 */
export function deriveAddress(descriptor: string, index: number, network: NetworkName): string {
  const output = new descriptors.Output({ descriptor, index, network: bitcoinNetwork(network) })
  return output.getAddress()
}
