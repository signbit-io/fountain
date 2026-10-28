import { describe, it, expect } from 'vitest'
import * as descriptors from '@bitcoinerlab/descriptors'
import { accountKey, signApproval, policyMsgHash } from './key.js'
import type { NetworkName } from './bitcoin-network.js'

/*
  THE compatibility test — pins the client's output to the SignBit platform's exact spec so
  any drift fails CI. The golden values below were cross-verified by running the platform's OWN
  descriptor builder + approval verifier against this key: the platform builds the identical
  descriptor+checksum from this tpub, and accepts an approval this key signs.

  Fixed vector: the canonical BIP-39 test mnemonic (all "abandon" + "about").
*/

const TESTNET: NetworkName = 'testnet'
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// Golden values for m/48'/1'/0'/2' from VECTOR_MNEMONIC (proven against the platform).
const GOLDEN = {
  tpub: 'tpubDFH9dgzveyD8zTbPUFuLrGmCydNvxehyNdUXKJAQN8x4aZ4j6UZqGfnqFrD4NqyaTVGKbvEW54tsvPTK2UoSbCC1PJY8iCNiwTL3RWZEheQ',
  masterFingerprint: '73c5da0a',
  derivationPath: "48'/1'/0'/2'",
  child0_0Pubkey: '030b90ed2e86bad7f2a4fe9769bb417d7ba9caa1124807dbfb362dfbeeb65e7e01',
  // wsh(sortedmulti(1, ...)) receive descriptor + checksum, exactly as the platform emits.
  receiveDescriptor:
    "wsh(sortedmulti(1,[73c5da0a/48'/1'/0'/2']tpubDFH9dgzveyD8zTbPUFuLrGmCydNvxehyNdUXKJAQN8x4aZ4j6UZqGfnqFrD4NqyaTVGKbvEW54tsvPTK2UoSbCC1PJY8iCNiwTL3RWZEheQ/0/*))#pmetja34",
}

describe('compatibility contract with the SignBit platform', () => {
  it('exports the exact tpub + master fingerprint + path for the BIP-48 account', () => {
    const k = accountKey(VECTOR_MNEMONIC, TESTNET)
    expect(k.tpub).toBe(GOLDEN.tpub)
    expect(k.masterFingerprint).toBe(GOLDEN.masterFingerprint)
    expect(k.derivationPath).toBe(GOLDEN.derivationPath)
  })

  it('builds a descriptor byte-identical to the platform descriptor builder', () => {
    const k = accountKey(VECTOR_MNEMONIC, TESTNET)
    // Reproduce the platform's key expression + wsh(sortedmulti) + checksum.
    const expr = `[${k.masterFingerprint}/${k.derivationPath}]${k.tpub}/0/*`
    const body = `wsh(sortedmulti(1,${expr}))`
    const desc = `${body}#${descriptors.checksum(body)}`
    expect(desc).toBe(GOLDEN.receiveDescriptor)
  })

  it('policyMsgHash is double-SHA256 of the UTF-8 payload (matches the platform)', () => {
    // sha256(sha256("")) known vector.
    const emptyDoubleSha = '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456'
    expect(policyMsgHash('').toString('hex')).toBe(emptyDoubleSha)
  })

  it('signs a policy approval verifiable by the platform (0/0 child, ECDSA over the hash)', () => {
    const payload =
      'SIGNBIT-POLICY-CHANGE\nvault:test\nchange:abc\nversion:1\ndiff:[]\nexpires:2099-01-01T00:00:00.000Z'
    const sig = signApproval(VECTOR_MNEMONIC, TESTNET, payload)
    // Verify with the SAME construction the platform's verifyPolicyApproval uses: derive the
    // 0/0 pubkey from the tpub and ecc.verify(hash, pubkey, sig).
    const ecc = descriptors.ecc as {
      verify: (h: Uint8Array, p: Uint8Array, s: Uint8Array) => boolean
    }
    const node = descriptors.BIP32.fromBase58(GOLDEN.tpub, descriptors.networks.testnet)
    const pubkey = node.derivePath('0/0').publicKey
    expect(Buffer.from(pubkey).toString('hex')).toBe(GOLDEN.child0_0Pubkey)
    const ok = ecc.verify(policyMsgHash(payload), pubkey, Buffer.from(sig, 'base64'))
    expect(ok).toBe(true)
  })
})
