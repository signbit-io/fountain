import * as descriptors from '@bitcoinerlab/descriptors'

/*
  Single network resolver — the ONLY place a network is chosen (mirrors the SignBit platform's
  lib/bitcoin-network.ts pattern).

  ── Mainnet is ENABLED here (this app only) ──────────────────────────────────────────
  This app used to hard-refuse mainnet via assertSignableNetwork(). That gate is gone, and
  what replaced it is NOT a weaker version of the same idea — it guards a different, real
  failure the old one only ever masked:

    signers.signBIP32 matches PSBT inputs by the PSBT's OWN bip32Derivation paths, NOT by
    multisigAccountPath(net). So the `net` argument passed to signPsbt does not decide which
    paths get signed. Verified empirically: a master node built with the TESTNET network
    object signs a real MAINNET-path PSBT with no error at all.

  Consequence: a key the user believes is testnet-only would sign a mainnet spend, driven
  purely by an attacker-supplied PSBT. assertPsbtCoinType() below is the actual choke point
  for that, and lib/key.ts's signPsbt calls it before signing. Keep it there.

  ⚠️ The network a key derives at is a property OF THE KEY (KeyEntry.network), never of the
  app's current toggle: the same seed yields a different account xpub per network (coin 0 vs
  coin 1), so deriving an existing key against the global setting silently produces the wrong
  key. Resolve from the entry's own stamp — see lib/keystore.tsx exportPublic().

  Use the descriptors package's OWN bundled bitcoinjs networks (descriptors.networks),
  NEVER top-level bitcoinjs-lib@6 — mixing them triggers a number-vs-bigint clash.
*/

export type NetworkName = 'testnet' | 'signet' | 'mainnet'

/** BIP-44 coin type: 1 for all test networks, 0 for mainnet. */
export function coinType(net: NetworkName): 0 | 1 {
  return net === 'mainnet' ? 0 : 1
}

/** BIP-48 account path for native-segwit (P2WSH) multisig — `48'/<coin>'/0'/2'`. */
export function multisigAccountPath(net: NetworkName): string {
  return `48'/${coinType(net)}'/0'/2'`
}

/**
 * The extended-public-key prefix this network's account keys carry: `tpub` on testnet/signet,
 * `xpub` on mainnet.
 *
 * ⚠️ For COPY ONLY — never for validation or parsing (build-descriptor.ts owns the full accepted
 * prefix set, which includes Vpub/Upub/Ypub/Zpub). It exists because user-facing strings used to
 * hardcode "tpub", which silently became wrong the moment mainnet was enabled: the same key
 * exports an xpub there, so the UI was naming a thing the user could not see on screen.
 */
export function xpubPrefix(net: NetworkName): 'tpub' | 'xpub' {
  return net === 'mainnet' ? 'xpub' : 'tpub'
}

/** The bitcoinjs Network object (from the descriptors bundle) for the given network. */
export function bitcoinNetwork(net: NetworkName) {
  // signet shares testnet's address/version bytes.
  return net === 'mainnet' ? descriptors.networks.bitcoin : descriptors.networks.testnet
}

/**
 * The BIP-44 coin type a derivation path declares, or null if the path isn't in a form we
 * recognise. Accepts both apostrophe and `h` hardened markers (`48'/0'/...` and `48h/0h/...`),
 * with or without a leading `m/`, since PSBTs are written by many different wallets.
 *
 * Only the SECOND element (the coin type) is read — the purpose that precedes it may be 48,
 * 45, 87 or anything else depending on the script type, and this check is deliberately about
 * the network alone.
 */
export function coinTypeOfPath(path: string): 0 | 1 | null {
  const parts = path.replace(/^m\//i, '').split('/')
  if (parts.length < 2) return null
  const coin = parts[1].replace(/['h]$/i, '')
  if (coin === '0') return 0
  if (coin === '1') return 1
  return null
}

/**
 * THE signing choke point for network confusion (see the header): reject a PSBT whose own
 * derivation paths belong to a different network than the key about to sign it.
 *
 * ⚠️ Only derivations matching THIS key's master fingerprint are checked. A multisig PSBT
 * carries every cosigner's derivation, and another keyholder's unusual path must not block a
 * legitimate signature.
 *
 * A path we cannot parse is NOT treated as a mismatch — the coin type is the only thing being
 * asserted here, and refusing every unfamiliar path shape would break valid PSBTs from other
 * wallets without making anyone safer.
 *
 * @throws if any of this key's inputs derive at the wrong coin type for `net`.
 */
export function assertPsbtCoinType(
  net: NetworkName,
  derivations: { masterFingerprint: string; path: string }[],
  ourFingerprint: string,
): void {
  const expected = coinType(net)
  const ours = ourFingerprint.toLowerCase()
  for (const d of derivations) {
    if (d.masterFingerprint.toLowerCase() !== ours) continue
    const actual = coinTypeOfPath(d.path)
    if (actual === null || actual === expected) continue
    const claimed = actual === 0 ? 'mainnet' : 'testnet'
    throw new Error(
      `This PSBT is for ${claimed} (derivation ${d.path}) but this key is a ${net} key. ` +
        'Refusing to sign — select the key that matches this PSBT.',
    )
  }
}
