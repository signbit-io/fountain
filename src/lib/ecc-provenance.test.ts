import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as ecc from '@bitcoinerlab/secp256k1'

/*
  SUPPLY-CHAIN guard: the ECC backend must stay @noble/curves, never crypto-browserify's
  `elliptic`.

  ⚠️ WHY THIS EXISTS. `npm audit` flags elliptic@6.6.1 (GHSA-848j-6mx2-7j84, "risky
  cryptographic primitive") in this repo's tree. It is NOT reachable from any signing path —
  it arrives only via vite-plugin-node-polyfills → node-stdlib-browser → crypto-browserify →
  browserify-sign/create-ecdh, none of which we call. Our ECC is @bitcoinerlab/secp256k1
  (→ @noble/curves) and our KDF is @noble/hashes' scrypt (see crypto.ts).

  But that separation is currently a fact about MODULE STRUCTURE, not an enforced invariant.
  vite.config.ts polyfills `crypto` into the webview, so crypto-browserify's ECDSA sits one
  careless import away from the signing path — and nothing would fail loudly if a future
  refactor or dependency bump routed real key operations through it. Signatures would still
  verify; they would just be produced by an unaudited implementation with a known advisory.
  That is precisely the class of regression a test has to catch, because review will not.

  These assertions are cheap and pure. If one fails, do NOT "fix" it by relaxing the
  assertion — find out what pulled elliptic into the crypto path and undo that.
*/

const require = createRequire(import.meta.url)

/** Walk a package's real dependency closure via package.json `dependencies`. */
function dependencyClosure(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const name = queue.pop()!
    if (seen.has(name)) continue
    seen.add(name)
    let manifest: { dependencies?: Record<string, string> }
    try {
      manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8'))
    } catch {
      // Not resolvable from here (peer/optional, or exports-restricted) — nothing to walk.
      continue
    }
    for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push(dep)
  }
  return seen
}

describe('SUPPLY CHAIN: the ECC backend is @noble, not elliptic', () => {
  it('the signing ECC library resolves to @noble/curves and never pulls in elliptic', () => {
    const closure = dependencyClosure('@bitcoinerlab/secp256k1')
    expect(closure.has('@noble/curves')).toBe(true)
    expect(closure.has('elliptic')).toBe(false)
  })

  it('neither bitcoinjs-lib nor bip32 reaches elliptic', () => {
    for (const pkg of ['bitcoinjs-lib', 'bip32']) {
      expect(dependencyClosure(pkg).has('elliptic')).toBe(false)
    }
  })

  it('the descriptors package — which owns the PSBT signers we call — never reaches elliptic', () => {
    // signPsbt/signApproval go through descriptors' own bundled bitcoinjs (see key.ts),
    // so this is the closure that actually touches key material.
    expect(dependencyClosure('@bitcoinerlab/descriptors').has('elliptic')).toBe(false)
  })

  it('elliptic is confined to the build-time node polyfill, if present at all', () => {
    // It is allowed to EXIST in the tree (crypto-browserify vendors it) — this test pins
    // that it got there via the polyfill and not via anything we sign with.
    let ellipticInstalled = true
    try {
      require.resolve('elliptic/package.json')
    } catch {
      ellipticInstalled = false
    }
    if (!ellipticInstalled) return // Even better — nothing to confine.
    expect(dependencyClosure('crypto-browserify').has('elliptic')).toBe(true)
  })

  it('the ECC backend exposes the real secp256k1 curve order (sanity, not a stub)', () => {
    // A substituted/hollowed-out backend is the failure this catches: the module resolved,
    // but it is not the curve we think it is. n = the secp256k1 group order.
    const G = ecc.pointFromScalar(
      Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
      true,
    )
    expect(Buffer.from(G!).toString('hex')).toBe(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    )
  })
})
