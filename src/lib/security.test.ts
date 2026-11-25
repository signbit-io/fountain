import { describe, it, expect } from 'vitest'
import * as descriptors from '@bitcoinerlab/descriptors'
import {
  generateKey,
  accountKey,
  signApproval,
  signPsbt,
  policyMsgHash,
} from './key.js'
import { mnemonicToSeedSync } from '@scure/bip39'
import { encryptKeystore, decryptKeystore, type KeyEntry } from './crypto.js'
import { assertPsbtCoinType, type NetworkName } from './bitcoin-network.js'

/*
  SECURITY invariants — the properties that MUST hold for a key-holding signer. These are the
  ones that, if they regress, leak or misuse key material. Kept separate from the functional
  tests so they read as a security checklist.
*/

const TESTNET: NetworkName = 'testnet'
const PLACEHOLDER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('SECURITY: no private material ever leaves the signer', () => {
  it('accountKey exports only a PUBLIC tpub — never an xprv/tprv', () => {
    const k = accountKey(generateKey(), TESTNET)
    expect(k.tpub.startsWith('tpub')).toBe(true)
    // A neutered node has no private prefix; assert the export contains none of them.
    const blob = JSON.stringify(k)
    for (const priv of ['tprv', 'xprv', 'zprv', 'vprv', 'Zprv', 'Vprv']) {
      expect(blob.includes(priv)).toBe(false)
    }
    // And the tpub really is watch-only (round-trips to a node with no private key).
    const node = descriptors.BIP32.fromBase58(k.tpub, descriptors.networks.testnet)
    expect(node.privateKey).toBeUndefined()
  })

  it('the same mnemonic always yields the same account key (deterministic, no entropy leak)', () => {
    const a = accountKey(PLACEHOLDER, TESTNET)
    const b = accountKey(PLACEHOLDER, TESTNET)
    expect(a).toEqual(b)
  })
})

/*
  MAINNET is enabled in this build. These tests replaced two that asserted mainnet was
  hard-refused on both signing paths — that blanket refusal was removed deliberately, and what
  matters now is the invariant it had been MASKING (see the next describe block).
*/
describe('SECURITY: a key derives per-network and mainnet is signable', () => {
  it('the same seed yields a DIFFERENT account key per network', () => {
    // The reason KeyEntry carries its own network stamp. If this ever collapsed to one key,
    // the stamp would be pointless and an enrolled key could be re-derived wrongly in silence.
    const t = accountKey(PLACEHOLDER, 'testnet')
    const m = accountKey(PLACEHOLDER, 'mainnet')
    expect(t.tpub).not.toBe(m.tpub)
    expect(t.tpub.startsWith('tpub')).toBe(true)
    expect(m.tpub.startsWith('xpub')).toBe(true)
    expect(t.derivationPath).toBe("48'/1'/0'/2'")
    expect(m.derivationPath).toBe("48'/0'/0'/2'")
  })

  it('the MASTER FINGERPRINT is identical across networks', () => {
    // Load-bearing for backup-diff, which identifies a key by fingerprint and must therefore
    // stay network-independent. It also means a network check can NEVER use the fingerprint.
    expect(accountKey(PLACEHOLDER, 'testnet').masterFingerprint).toBe(
      accountKey(PLACEHOLDER, 'mainnet').masterFingerprint,
    )
  })

  it('signApproval works on mainnet (no blanket refusal any more)', () => {
    const sig = signApproval(PLACEHOLDER, 'mainnet', 'SIGNBIT-POLICY-CHANGE\nvault:v1')
    expect(sig.length).toBeGreaterThan(0)
    // And it is genuinely a DIFFERENT signature than the testnet key would produce.
    expect(sig).not.toBe(signApproval(PLACEHOLDER, 'testnet', 'SIGNBIT-POLICY-CHANGE\nvault:v1'))
  })
})

/*
  ⚠️ THE test this whole mainnet change hangs on.

  signers.signBIP32 matches inputs by the PSBT's OWN bip32Derivation paths, NOT by the `net`
  argument. Before the guard in signPsbt existed, this was verified by experiment: a master node
  built with the TESTNET network object signed a real MAINNET-path PSBT and returned no error.

  So the old `assertSignableNetwork` refusal was masking a genuine hole rather than closing it —
  a key the user believes is testnet-only would sign a mainnet spend on an attacker-supplied
  PSBT. If someone deletes the assertPsbtCoinType call from signPsbt, THIS is what fails.
*/
describe('SECURITY: a PSBT cannot drag a key onto the wrong network', () => {
  /** A real single-sig-in-P2WSH PSBT built at `net`'s BIP-48 path for PLACEHOLDER. */
  function psbtAt(net: NetworkName): string {
    const master = descriptors.BIP32.fromSeed(
      Buffer.from(mnemonicToSeedSync(PLACEHOLDER)),
      net === 'mainnet' ? descriptors.networks.bitcoin : descriptors.networks.testnet,
    )
    const coin = net === 'mainnet' ? 0 : 1
    const account = master.derivePath(`m/48'/${coin}'/0'/2'`)
    const fp = Buffer.from(master.fingerprint).toString('hex')
    const descriptor = `wsh(sortedmulti(1,[${fp}/48'/${coin}'/0'/2']${account.neutered().toBase58()}/0/*))`
    const network = net === 'mainnet' ? descriptors.networks.bitcoin : descriptors.networks.testnet
    const output = new descriptors.Output({ descriptor, index: 0, network })
    const spk = Buffer.from(output.getScriptPubKey())

    // Minimal funding tx paying that script (bundled bitcoinjs uses bigint values).
    const bjs = descriptors.createBitcoinjsLib(descriptors.ecc as never) as unknown as {
      Transaction: new () => {
        version: number
        addInput: (hash: Buffer, index: number) => void
        addOutput: (script: Buffer, value: bigint) => void
        toHex: () => string
      }
    }
    const funding = new bjs.Transaction()
    funding.version = 2
    funding.addInput(Buffer.alloc(32, 1), 0)
    funding.addOutput(spk, 10000n)

    const psbt = new descriptors.Psbt({ network } as never)
    output.updatePsbtAsInput({ psbt, txHex: funding.toHex(), vout: 0 })
    psbt.addOutput({ script: spk, value: 9000n } as never)
    return psbt.toBase64()
  }

  it('REFUSES to sign a mainnet PSBT with a testnet key', () => {
    expect(() => signPsbt(PLACEHOLDER, 'testnet', psbtAt('mainnet'))).toThrow(/different network|mainnet/i)
  })

  it('REFUSES to sign a testnet PSBT with a mainnet key', () => {
    expect(() => signPsbt(PLACEHOLDER, 'mainnet', psbtAt('testnet'))).toThrow(/different network|testnet/i)
  })

  it('SIGNS when the PSBT and the key agree — on both networks', () => {
    // The guard must not be so blunt it blocks legitimate signing; without these, a gate that
    // simply threw every time would pass the two tests above.
    expect(signPsbt(PLACEHOLDER, 'testnet', psbtAt('testnet')).length).toBeGreaterThan(0)
    expect(signPsbt(PLACEHOLDER, 'mainnet', psbtAt('mainnet')).length).toBeGreaterThan(0)
  })

  it('ignores derivations belonging to OTHER cosigners', () => {
    // A multisig PSBT carries every keyholder's derivation. Only ours is our business — a
    // cosigner using an unusual path must never block a signature we are entitled to make.
    const stranger = [{ masterFingerprint: 'deadbeef', path: "m/48'/0'/0'/2'/0/0" }]
    expect(() => assertPsbtCoinType('testnet', stranger, '73c5da0a')).not.toThrow()
  })

  it('does not reject a path shape it cannot parse', () => {
    // Refusing every unfamiliar path would break valid PSBTs from other wallets without making
    // anyone safer — the coin type is the only thing being asserted.
    const odd = [{ masterFingerprint: '73c5da0a', path: 'm' }]
    expect(() => assertPsbtCoinType('testnet', odd, '73c5da0a')).not.toThrow()
  })

  it('REFUSES a Taproot input that names this key, whatever network its path claims', () => {
    /*
      🚨 The network gate reads `bip32Derivation` only, but signBIP32 ALSO signs any input whose
      `tapBip32Derivation` names this key (2026-10-04 sweep): a testnet-stamped key produced a
      Schnorr signature for a coin-0 path. Fountain's keys only ever sit in P2WSH multisig, so a
      Taproot signature is never one it should make, on either network.
    */
    const master = descriptors.BIP32.fromSeed(Buffer.from(mnemonicToSeedSync(PLACEHOLDER)), descriptors.networks.bitcoin)
    const path = "m/86'/0'/0'/0/0"
    const xonly = master.derivePath(path).publicKey.slice(1, 33)
    const network = descriptors.networks.bitcoin
    const output = new descriptors.Output({ descriptor: `tr(${Buffer.from(xonly).toString('hex')})`, network })
    const bjs = descriptors.createBitcoinjsLib(descriptors.ecc as never) as unknown as {
      Transaction: new () => {
        version: number
        addInput: (hash: Buffer, index: number) => void
        addOutput: (script: Uint8Array, value: bigint) => void
        toBuffer: () => Uint8Array
        getHash: () => Uint8Array
      }
    }
    const funding = new bjs.Transaction()
    funding.version = 2
    funding.addInput(Buffer.alloc(32, 1), 0)
    funding.addOutput(output.getScriptPubKey(), 50_000n)

    const psbt = new descriptors.Psbt({ network } as never)
    psbt.addInput({
      hash: funding.getHash(),
      index: 0,
      nonWitnessUtxo: funding.toBuffer(),
      witnessUtxo: { script: output.getScriptPubKey(), value: 50_000n },
      tapInternalKey: xonly,
      tapBip32Derivation: [{ masterFingerprint: master.fingerprint, pubkey: xonly, path, leafHashes: [] }],
    } as never)
    psbt.addOutput({ script: output.getScriptPubKey(), value: 49_000n } as never)

    expect(() => signPsbt(PLACEHOLDER, 'testnet', psbt.toBase64())).toThrow(/Taproot/i)
    expect(() => signPsbt(PLACEHOLDER, 'mainnet', psbt.toBase64())).toThrow(/Taproot/i)
  })
})

describe('SECURITY: policy-approval signatures are bound + non-forgeable', () => {
  it('a signature verifies ONLY for the exact payload it signed (tamper → reject)', () => {
    const payload = 'SIGNBIT-POLICY-CHANGE\nvault:v1\nchange:c1\nversion:1\ndiff:[]\nexpires:2099-01-01T00:00:00.000Z'
    const sig = signApproval(PLACEHOLDER, TESTNET, payload)
    const ecc = descriptors.ecc as { verify: (h: Uint8Array, p: Uint8Array, s: Uint8Array) => boolean }
    const pubkey = descriptors.BIP32.fromBase58(accountKey(PLACEHOLDER, TESTNET).tpub, descriptors.networks.testnet)
      .derivePath('0/0').publicKey
    // Correct payload verifies.
    expect(ecc.verify(policyMsgHash(payload), pubkey, Buffer.from(sig, 'base64'))).toBe(true)
    // A single-character change (version 1 → 2, the anti-rebase bind) must NOT verify.
    const tampered = payload.replace('version:1', 'version:2')
    expect(ecc.verify(policyMsgHash(tampered), pubkey, Buffer.from(sig, 'base64'))).toBe(false)
  })

  it("one key's approval does NOT verify against another key's pubkey", () => {
    const payload = 'SIGNBIT-POLICY-CHANGE\nvault:v1\nversion:1'
    const sig = signApproval(PLACEHOLDER, TESTNET, payload)
    const ecc = descriptors.ecc as { verify: (h: Uint8Array, p: Uint8Array, s: Uint8Array) => boolean }
    const otherPubkey = descriptors.BIP32.fromBase58(accountKey(generateKey(), TESTNET).tpub, descriptors.networks.testnet)
      .derivePath('0/0').publicKey
    expect(ecc.verify(policyMsgHash(payload), otherPubkey, Buffer.from(sig, 'base64'))).toBe(false)
  })
})

describe('SECURITY: keystore protects secrets at rest', () => {
  const entries: KeyEntry[] = [
    { id: 'a', label: 'Secret Key', mnemonic: PLACEHOLDER, createdAt: '2026-01-01T00:00:00.000Z' },
  ]

  it('no mnemonic word, label, or key id leaks outside the ciphertext envelope', () => {
    const store = encryptKeystore(entries, 'pw-123456')
    const blob = JSON.stringify(store)
    expect(blob).not.toContain('abandon')
    expect(blob).not.toContain('about')
    expect(blob).not.toContain('Secret Key')
    // The envelope exposes only KDF params + salt/iv/tag/ct — no plaintext fields.
    expect(Object.keys(store).sort()).toEqual(['cipher', 'ct', 'iv', 'kdf', 'salt', 'scrypt', 'tag', 'version'])
  })

  it('a wrong passphrase is rejected by AEAD (no partial/garbage plaintext returned)', () => {
    const store = encryptKeystore(entries, 'right-passphrase')
    expect(() => decryptKeystore(store, 'Right-passphrase')).toThrow() // case-sensitive
    expect(() => decryptKeystore(store, 'wrong')).toThrow()
  })

  it('any tampering with ciphertext, tag, iv, or salt fails authentication', () => {
    const base = encryptKeystore(entries, 'pw-123456')
    for (const field of ['ct', 'tag', 'iv', 'salt'] as const) {
      const buf = Buffer.from(base[field], 'base64')
      buf[0] ^= 0xff
      const tampered = { ...base, [field]: buf.toString('base64') }
      expect(() => decryptKeystore(tampered, 'pw-123456')).toThrow()
    }
  })

  it('encrypting the same data twice never produces the same ciphertext (fresh salt+iv)', () => {
    const a = encryptKeystore(entries, 'pw-123456')
    const b = encryptKeystore(entries, 'pw-123456')
    expect(a.ct).not.toBe(b.ct)
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
  })

  it('uses a memory-hard KDF (scrypt) with non-trivial cost parameters', () => {
    const store = encryptKeystore(entries, 'pw-123456')
    expect(store.kdf).toBe('scrypt')
    expect(store.cipher).toBe('aes-256-gcm')
    // Floor at 2^16. The on-disk envelope is the ONLY brute-force defense (offline attack),
    // so guard against an accidental KDF-cost downgrade. Current default is 2^17 (131072).
    expect(store.scrypt.N).toBeGreaterThanOrEqual(65536)
  })
})
