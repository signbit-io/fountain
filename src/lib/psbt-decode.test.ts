import { describe, it, expect } from 'vitest'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as descriptors from '@bitcoinerlab/descriptors'
import { generateKey, accountKey, signPsbt } from './key.js'
import {
  decodePsbt,
  findMatchingChangeDescriptor,
  countMatchingVaults,
  matchVaults,
  type DecodedPsbt,
  type DecodeError,
} from './psbt-decode.js'
import type { NetworkName } from './bitcoin-network.js'

const TESTNET: NetworkName = 'testnet'
const { Output, Psbt } = descriptors
const net = descriptors.networks.testnet
const bjs = descriptors.createBitcoinjsLib(ecc) as unknown as {
  address: { toOutputScript: (a: string, n: unknown) => Uint8Array }
  Transaction: new () => {
    version: number
    addInput: (hash: Uint8Array, index: number) => void
    addOutput: (script: Uint8Array, value: bigint) => void
    toHex: () => string
  }
}

/** Build a 3-of-5 vault (receive + change descriptors) from 5 fresh client keys. */
function buildVault(m = 3) {
  const mnemonics = Array.from({ length: 5 }, () => generateKey())
  const keys = mnemonics.map((mn) => accountKey(mn, TESTNET))
  const receiveExprs = keys.map((k) => `[${k.masterFingerprint}/${k.derivationPath}]${k.tpub}/0/*`)
  const changeExprs = keys.map((k) => `[${k.masterFingerprint}/${k.derivationPath}]${k.tpub}/1/*`)
  const receiveBody = `wsh(sortedmulti(${m},${receiveExprs.join(',')}))`
  const changeBody = `wsh(sortedmulti(${m},${changeExprs.join(',')}))`
  return {
    mnemonics,
    descriptor: `${receiveBody}#${descriptors.checksum(receiveBody)}`,
    changeDescriptor: `${changeBody}#${descriptors.checksum(changeBody)}`,
  }
}

/** Fund a fresh Output's address with a fake prev-tx (segwit; witnessUtxo path). */
function fundAddress(address: string, valueSats: number) {
  const prev = new bjs.Transaction()
  prev.version = 2
  prev.addInput(Buffer.alloc(32, 1), 0)
  prev.addOutput(bjs.address.toOutputScript(address, net), BigInt(valueSats))
  return prev.toHex()
}

describe('decodePsbt', () => {
  it('decodes a single-recipient spend with correct amount and fee (degraded — no change descriptor)', () => {
    const { descriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 100_000)

    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    const recipient = new Output({ descriptor, index: 5, network: net }).getAddress()
    psbt.addOutput({ address: recipient, value: BigInt(90_000) } as never)

    const result = decodePsbt(psbt.toBase64(), TESTNET) as DecodedPsbt
    expect(result.changeClassified).toBe(false)
    expect(result.feeSats).toBe(10_000)
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0].address).toBe(recipient)
    expect(result.outputs[0].amountSats).toBe(90_000)
    expect(result.outputs[0].change).toBe('unknown') // no descriptor -> never guess
  })

  it('classifies recipient vs change correctly when the change descriptor is cached', () => {
    const { descriptor, changeDescriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 100_000)

    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    const recipient = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' // any valid unrelated testnet address
    const changeAddr = new Output({ descriptor: changeDescriptor, index: 0, network: net }).getAddress()
    psbt.addOutput({ address: recipient, value: BigInt(70_000) } as never)
    psbt.addOutput({ address: changeAddr, value: BigInt(25_000) } as never)

    const result = decodePsbt(psbt.toBase64(), TESTNET, changeDescriptor) as DecodedPsbt
    expect(result.changeClassified).toBe(true)
    expect(result.feeSats).toBe(5_000)
    const recipientOut = result.outputs.find((o) => o.address === recipient)
    const changeOut = result.outputs.find((o) => o.address === changeAddr)
    expect(recipientOut).toMatchObject({ amountSats: 70_000, change: 'recipient' })
    expect(changeOut).toMatchObject({ amountSats: 25_000, change: 'change' })
  })

  it('never trusts a label — classification is purely script-membership-based', () => {
    // Build a PSBT where the "recipient" output's script is deliberately at a change-branch
    // index, to prove classification looks at the actual script rather than output order/any
    // metadata — a malicious PSBT could rely on the app trusting the wrong signal.
    const { descriptor, changeDescriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 50_000)
    const trueChangeAddr = new Output({ descriptor: changeDescriptor, index: 3, network: net }).getAddress()

    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: trueChangeAddr, value: BigInt(45_000) } as never) // listed first

    const result = decodePsbt(psbt.toBase64(), TESTNET, changeDescriptor) as DecodedPsbt
    expect(result.outputs[0].change).toBe('change') // correctly identified regardless of position
  })

  it('handles multiple recipient outputs (no forced single-recipient assumption)', () => {
    const { descriptor, changeDescriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 200_000)
    const addrA = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
    const addrB = new Output({ descriptor, index: 9, network: net }).getAddress()

    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: addrA, value: BigInt(60_000) } as never)
    psbt.addOutput({ address: addrB, value: BigInt(80_000) } as never)

    const result = decodePsbt(psbt.toBase64(), TESTNET, changeDescriptor) as DecodedPsbt
    expect(result.outputs).toHaveLength(2)
    expect(result.outputs.every((o) => o.change === 'recipient')).toBe(true)
    expect(result.feeSats).toBe(60_000)
  })

  it('returns a DecodeError for garbage input rather than throwing', () => {
    const result = decodePsbt('not-a-real-psbt', TESTNET)
    expect('reason' in result).toBe(true)
  })

  it('returns a DecodeError for a PSBT with no inputs', () => {
    const psbt = new Psbt({ network: net as never })
    const dest = new Output({ descriptor: buildVault().descriptor, index: 0, network: net }).getAddress()
    psbt.addOutput({ address: dest, value: BigInt(1000) } as never)
    const result = decodePsbt(psbt.toBase64(), TESTNET)
    expect('reason' in result).toBe(true)
  })

  it('is display-only: decoding does not require or consume a signing key', () => {
    // No mnemonic/key material passed anywhere in this module's surface — decodePsbt takes
    // only the PSBT text + network + an optional PUBLIC descriptor string.
    const { descriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 10_000)
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(9_000) } as never)
    expect(() => decodePsbt(psbt.toBase64(), TESTNET)).not.toThrow()
  })
})

describe('findMatchingChangeDescriptor', () => {
  it('finds the cached vault whose receive branch matches the PSBT input, among several candidates', () => {
    const vaultA = buildVault()
    const vaultB = buildVault()
    const source = new Output({ descriptor: vaultB.descriptor, index: 2, network: net })
    const prevHex = fundAddress(source.getAddress(), 50_000)
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(45_000) } as never)

    const found = findMatchingChangeDescriptor(psbt.toBase64(), TESTNET, [
      { descriptor: vaultA.descriptor, changeDescriptor: vaultA.changeDescriptor },
      { descriptor: vaultB.descriptor, changeDescriptor: vaultB.changeDescriptor },
    ])
    expect(found).toBe(vaultB.changeDescriptor)
  })

  it('returns undefined when no cached vault matches (degraded mode territory)', () => {
    const vaultA = buildVault()
    const unrelated = buildVault()
    const source = new Output({ descriptor: unrelated.descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 10_000)
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(9_000) } as never)

    const found = findMatchingChangeDescriptor(psbt.toBase64(), TESTNET, [
      { descriptor: vaultA.descriptor, changeDescriptor: vaultA.changeDescriptor },
    ])
    expect(found).toBeUndefined()
  })

  it('returns undefined for garbage PSBT input rather than throwing', () => {
    const vaultA = buildVault()
    expect(
      findMatchingChangeDescriptor('not-a-psbt', TESTNET, [
        { descriptor: vaultA.descriptor, changeDescriptor: vaultA.changeDescriptor },
      ]),
    ).toBeUndefined()
  })
})

/*
  🚨 DISPLAY-vs-SIGNATURE: the input VALUES that produce the fee.

  A PSBT can state an input's value twice — in `witnessUtxo.value`, and implicitly via
  `nonWitnessUtxo` (the whole previous transaction). Only the latter is bound to anything: the
  signer checks its txid against the input's prevout hash, so it cannot be forged for a real
  input, while `witnessUtxo` is a bare {script, value} an attacker writes at will.

  Understating an input does not touch a single output amount — it lands entirely on the fee,
  which is the one figure on screen the user cannot independently verify (an output address and
  amount they can read; an input's true value lives on-chain). That is what makes it the
  sharpest version of the display-vs-signature attack, so it is pinned here.
*/
describe('🚨 input values: the fee cannot be understated by a lying witnessUtxo', () => {
  /** An input whose two value fields disagree — the forgeable one understating the real one. */
  function psbtWithContradictoryInputValue(trueSats: number, statedSats: number) {
    const { descriptor, changeDescriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), trueSats)

    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(90_000) } as never)

    // updatePsbtAsInput populates BOTH fields; overwrite only the forgeable one.
    const raw = (psbt as unknown as { data: { inputs: { witnessUtxo: { script: Uint8Array; value: bigint } }[] } }).data
      .inputs[0]
    raw.witnessUtxo = { script: raw.witnessUtxo.script, value: BigInt(statedSats) }
    return { psbtBase64: psbt.toBase64(), changeDescriptor }
  }

  it('refuses to render a spend whose input states two different values', () => {
    // The attack: a real 1 BTC input understated to 100_000 sats. Every output amount stays
    // honest, so only the fee absorbs the lie — it would have read as a normal 10_000-sat fee
    // for a transaction that actually burns ~1 BTC to miners.
    const { psbtBase64, changeDescriptor } = psbtWithContradictoryInputValue(100_000_000, 100_000)
    const result = decodePsbt(psbtBase64, TESTNET, changeDescriptor)
    expect(result).toHaveProperty('reason')
    expect((result as DecodeError).reason).toMatch(/two different values/i)
  })

  it('refuses in the overstating direction too — a mismatch has no honest cause', () => {
    const { psbtBase64, changeDescriptor } = psbtWithContradictoryInputValue(100_000, 100_000_000)
    expect(decodePsbt(psbtBase64, TESTNET, changeDescriptor)).toHaveProperty('reason')
  })

  it('prefers the txid-bound previous transaction, which is what the SIGNATURE commits to', () => {
    // The precedence itself: the displayed fee must be computed from the same field the signer
    // treats as authoritative, or display and signature can disagree by construction.
    const { descriptor, changeDescriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 100_000)
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(90_000) } as never)

    const result = decodePsbt(psbt.toBase64(), TESTNET, changeDescriptor) as DecodedPsbt
    expect(result.feeSats).toBe(10_000)
    expect(result.feeLooksWrong).toBe(false)
  })
})

describe('fee sanity flag (the residual defence where nothing can cross-check)', () => {
  /*
    A segwit-only PSBT can carry `witnessUtxo` alone, with no previous transaction to
    contradict it — the cross-check above has nothing to compare against. What survives is the
    SHAPE of the result: an understated input makes the fee an absurd share of the spend.
    Advisory, never blocking — the display side must not decide a user's transaction is invalid.
  */
  it('flags a fee that is an implausible share of the inputs', () => {
    const { descriptor, changeDescriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 100_000)
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(10_000) } as never) // 90% to fee

    const result = decodePsbt(psbt.toBase64(), TESTNET, changeDescriptor) as DecodedPsbt
    expect(result.feeSats).toBe(90_000)
    expect(result.feeLooksWrong).toBe(true)
  })

  it('does not flag an ordinary fee', () => {
    const { descriptor, changeDescriptor } = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const prevHex = fundAddress(source.getAddress(), 100_000)
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: prevHex, vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(97_500) } as never)

    const result = decodePsbt(psbt.toBase64(), TESTNET, changeDescriptor) as DecodedPsbt
    expect(result.feeSats).toBe(2_500)
    expect(result.feeLooksWrong).toBe(false)
  })
})

describe('inputs spanning MORE THAN ONE cached vault', () => {
  /*
    Change is classified against a single descriptor — right for the normal case, where a spend
    draws on one vault. When inputs span two, the panel can only speak for one of them: the
    other vault's real change reads as `recipient` (harmless — it overstates what leaves), but
    nothing on screen says a second vault is being spent from at all. That silence is the
    problem, so the count behind the warning is pinned here.
  */
  function twoVaultPsbt() {
    const vaultA = buildVault()
    const vaultB = buildVault()
    const srcA = new Output({ descriptor: vaultA.descriptor, index: 0, network: net })
    const srcB = new Output({ descriptor: vaultB.descriptor, index: 0, network: net })

    const psbt = new Psbt({ network: net as never })
    srcA.updatePsbtAsInput({ psbt, txHex: fundAddress(srcA.getAddress(), 100_000), vout: 0 } as never)
    srcB.updatePsbtAsInput({ psbt, txHex: fundAddress(srcB.getAddress(), 100_000), vout: 0 } as never)
    psbt.addOutput({ address: srcA.getAddress(), value: BigInt(150_000) } as never)
    return { psbtBase64: psbt.toBase64(), vaultA, vaultB }
  }

  it('counts every contributing vault, not just the first match', () => {
    const { psbtBase64, vaultA, vaultB } = twoVaultPsbt()
    const candidates = [
      { descriptor: vaultA.descriptor, changeDescriptor: vaultA.changeDescriptor },
      { descriptor: vaultB.descriptor, changeDescriptor: vaultB.changeDescriptor },
    ]
    expect(countMatchingVaults(psbtBase64, TESTNET, candidates)).toBe(2)
  })

  it('counts one for an ordinary single-vault spend, so the warning stays quiet', () => {
    const { descriptor, changeDescriptor } = buildVault()
    const other = buildVault()
    const source = new Output({ descriptor, index: 0, network: net })
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: fundAddress(source.getAddress(), 100_000), vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(90_000) } as never)

    const candidates = [
      { descriptor, changeDescriptor },
      { descriptor: other.descriptor, changeDescriptor: other.changeDescriptor },
    ]
    expect(countMatchingVaults(psbt.toBase64(), TESTNET, candidates)).toBe(1)
  })

  it('classification still describes the FIRST matching vault, and never invents change', () => {
    // The safe direction, pinned so a future "improvement" cannot flip it: an output belonging
    // to the OTHER vault must read as recipient, never as change.
    const { psbtBase64, vaultA, vaultB } = twoVaultPsbt()
    const bChange = new Output({ descriptor: vaultB.changeDescriptor, index: 0, network: net }).getAddress()
    const psbt = Psbt.fromBase64(psbtBase64, { network: net as never })
    void psbt
    const decoded = decodePsbt(psbtBase64, TESTNET, vaultA.changeDescriptor) as DecodedPsbt
    for (const out of decoded.outputs) {
      if (out.address === bChange) expect(out.change).toBe('recipient')
    }
  })
})

describe('sighash: only SIGHASH_ALL can be signed (inherited from the signing library)', () => {
  /*
    ⚠️ PINS A DEPENDENCY DEFAULT, DELIBERATELY. A non-SIGHASH_ALL input changes what a
    signature commits to — SIGHASH_NONE commits to no outputs at all, so the panel above could
    show a recipient the signature does not cover. The decode panel does not mention sighash,
    which is only safe because `signers.signBIP32` calls bitcoinjs's `signAllInputsHD` WITHOUT
    a sighashTypes argument, and its default allowlist is [SIGHASH_ALL]. That is a transitive
    dependency's default argument, unpinned and undocumented — a library bump could widen it
    silently and nothing else in this repo would notice. Verified across the full matrix: ALL
    and absent sign; NONE, SINGLE and every ANYONECANPAY variant are refused.
  */
  const HOSTILE_SIGHASHES = [
    ['SIGHASH_NONE', 0x02],
    ['SIGHASH_SINGLE', 0x03],
    ['SIGHASH_ALL|ANYONECANPAY', 0x81],
    ['SIGHASH_NONE|ANYONECANPAY', 0x82],
    ['SIGHASH_SINGLE|ANYONECANPAY', 0x83],
  ] as const

  function psbtWithSighash(sighashType?: number) {
    const { mnemonics, descriptor } = buildVault(2)
    const source = new Output({ descriptor, index: 0, network: net })
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: fundAddress(source.getAddress(), 100_000), vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(90_000) } as never)
    if (sighashType !== undefined) {
      ;(psbt as unknown as { data: { inputs: { sighashType?: number }[] } }).data.inputs[0].sighashType = sighashType
    }
    return { mnemonic: mnemonics[0], psbtBase64: psbt.toBase64() }
  }

  it('signs an ordinary SIGHASH_ALL input', () => {
    const { mnemonic, psbtBase64 } = psbtWithSighash(0x01)
    expect(signPsbt(mnemonic, TESTNET, psbtBase64).length).toBeGreaterThan(0)
  })

  it.each(HOSTILE_SIGHASHES)('refuses to sign an input marked %s', (_label, sighashType) => {
    const { mnemonic, psbtBase64 } = psbtWithSighash(sighashType)
    expect(() => signPsbt(mnemonic, TESTNET, psbtBase64)).toThrow()
  })
})

describe('mainnet: the same protections, on the network that holds real money', () => {
  /*
    ⚠️ Every guard in this file is network-agnostic by construction — the value cross-check and
    the fee ratio are arithmetic on the PSBT's own fields, and the sighash refusal lives in the
    signing library. Nothing branches on testnet vs mainnet. That is easy to ASSERT and cheap to
    get wrong later (a network-specific early return, a testnet-only fixture path), and mainnet
    is where the cost of being wrong is real, so it is exercised rather than argued.
  */
  const MAINNET: NetworkName = 'mainnet'
  const mainnet = descriptors.networks.bitcoin

  function mainnetVault(m = 2) {
    const mnemonics = Array.from({ length: 3 }, () => generateKey())
    const keys = mnemonics.map((mn) => accountKey(mn, MAINNET))
    const receiveExprs = keys.map((k) => `[${k.masterFingerprint}/${k.derivationPath}]${k.tpub}/0/*`)
    const changeExprs = keys.map((k) => `[${k.masterFingerprint}/${k.derivationPath}]${k.tpub}/1/*`)
    const receiveBody = `wsh(sortedmulti(${m},${receiveExprs.join(',')}))`
    const changeBody = `wsh(sortedmulti(${m},${changeExprs.join(',')}))`
    return {
      mnemonics,
      descriptor: `${receiveBody}#${descriptors.checksum(receiveBody)}`,
      changeDescriptor: `${changeBody}#${descriptors.checksum(changeBody)}`,
    }
  }

  function fundMainnet(address: string, valueSats: number) {
    const prev = new bjs.Transaction()
    prev.version = 2
    prev.addInput(Buffer.alloc(32, 1), 0)
    prev.addOutput(bjs.address.toOutputScript(address, mainnet), BigInt(valueSats))
    return prev.toHex()
  }

  it('decodes an ordinary mainnet spend, with bc1 addresses and a correct fee', () => {
    const { descriptor, changeDescriptor } = mainnetVault()
    const source = new Output({ descriptor, index: 0, network: mainnet })
    const psbt = new Psbt({ network: mainnet as never })
    source.updatePsbtAsInput({ psbt, txHex: fundMainnet(source.getAddress(), 100_000), vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(90_000) } as never)

    const result = decodePsbt(psbt.toBase64(), MAINNET, changeDescriptor) as DecodedPsbt
    expect(result.feeSats).toBe(10_000)
    expect(result.feeLooksWrong).toBe(false)
    expect(result.outputs[0].address.startsWith('bc1')).toBe(true)
  })

  it('🚨 refuses a contradictory input value on mainnet too', () => {
    const { descriptor, changeDescriptor } = mainnetVault()
    const source = new Output({ descriptor, index: 0, network: mainnet })
    const psbt = new Psbt({ network: mainnet as never })
    source.updatePsbtAsInput({ psbt, txHex: fundMainnet(source.getAddress(), 100_000_000), vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(90_000) } as never)

    const raw = (psbt as unknown as { data: { inputs: { witnessUtxo: { script: Uint8Array; value: bigint } }[] } }).data
      .inputs[0]
    raw.witnessUtxo = { script: raw.witnessUtxo.script, value: BigInt(100_000) }

    const result = decodePsbt(psbt.toBase64(), MAINNET, changeDescriptor)
    expect(result).toHaveProperty('reason')
    expect((result as DecodeError).reason).toMatch(/two different values/i)
  })

  it('🚨 refuses a hostile sighash on mainnet too', () => {
    const { mnemonics, descriptor } = mainnetVault()
    const source = new Output({ descriptor, index: 0, network: mainnet })
    const psbt = new Psbt({ network: mainnet as never })
    source.updatePsbtAsInput({ psbt, txHex: fundMainnet(source.getAddress(), 100_000), vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(90_000) } as never)
    ;(psbt as unknown as { data: { inputs: { sighashType?: number }[] } }).data.inputs[0].sighashType = 0x82

    expect(() => signPsbt(mnemonics[0], MAINNET, psbt.toBase64())).toThrow()
  })

  it('flags an implausible fee on mainnet too', () => {
    const { descriptor, changeDescriptor } = mainnetVault()
    const source = new Output({ descriptor, index: 0, network: mainnet })
    const psbt = new Psbt({ network: mainnet as never })
    source.updatePsbtAsInput({ psbt, txHex: fundMainnet(source.getAddress(), 100_000), vout: 0 } as never)
    psbt.addOutput({ address: source.getAddress(), value: BigInt(10_000) } as never)

    const result = decodePsbt(psbt.toBase64(), MAINNET, changeDescriptor) as DecodedPsbt
    expect(result.feeLooksWrong).toBe(true)
  })
})

/*
  ── 2026-10-04 MAINNET SWEEP ─────────────────────────────────────────────────────────────
  Everything below pins the rules that make the panel's numbers PROVEN rather than claimed.
*/

/** The fields of a PSBT input these tests rebuild (bip174 keeps nonWitnessUtxo read-only). */
type RawInput = {
  witnessUtxo?: { script: Uint8Array; value: bigint }
  nonWitnessUtxo?: Uint8Array
  witnessScript?: Uint8Array
  bip32Derivation?: { masterFingerprint: Uint8Array; pubkey: Uint8Array; path: string }[]
  sighashType?: number
}

/**
 * Rebuild a PSBT with one input's fields replaced. bip174 freezes `nonWitnessUtxo` once it is
 * cached, so the only faithful way to forge one is to build the PSBT again around it, which
 * is also exactly what an attacker holding the base64 does.
 */
function withInput(psbtBase64: string, index: number, patch: Partial<RawInput>): string {
  const src = Psbt.fromBase64(psbtBase64, { network: net as never })
  const out = new Psbt({ network: net as never })
  src.txInputs.forEach((txIn, i) => {
    const d = src.data.inputs[i] as RawInput
    const fields: RawInput = {
      witnessUtxo: d.witnessUtxo,
      nonWitnessUtxo: d.nonWitnessUtxo,
      witnessScript: d.witnessScript,
      bip32Derivation: d.bip32Derivation,
      sighashType: d.sighashType,
      ...(i === index ? patch : {}),
    }
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
    out.addInput({ hash: txIn.hash, index: txIn.index, sequence: txIn.sequence, ...clean } as never)
  })
  src.txOutputs.forEach((o) => out.addOutput({ script: o.script, value: o.value } as never))
  return out.toBase64()
}

/** The raw bytes of a previous transaction, as a PSBT's `nonWitnessUtxo` carries them. */
const rawTx = (hex: string): Uint8Array =>
  (descriptors.createBitcoinjsLib(ecc) as unknown as { Transaction: { fromHex: (h: string) => { toBuffer: () => Uint8Array } } })
    .Transaction.fromHex(hex)
    .toBuffer()

/** An ordinary spend from receive index 0 of `vault`, with the previous tx the platform sends. */
function vaultSpend(vault: ReturnType<typeof buildVault>, valueSats = 100_000) {
  const source = new Output({ descriptor: vault.descriptor, index: 0, network: net })
  const psbt = new Psbt({ network: net as never })
  source.updatePsbtAsInput({ psbt, txHex: fundAddress(source.getAddress(), valueSats), vout: 0 } as never)
  psbt.addOutput({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: BigInt(valueSats - 10_000) } as never)
  return { psbtBase64: psbt.toBase64(), source }
}

const fingerprintOf = (mnemonic: string) => accountKey(mnemonic, TESTNET).masterFingerprint

describe('🚨 every input is PROVEN by its previous transaction (2026-10-04)', () => {
  it('refuses a previous transaction that is not the one the input spends', () => {
    /*
      The signer checks this hash and silently SKIPS the input when it fails, so a forged
      previous transaction used to set the panel's fee while producing no signature at all.
      Two such sessions, each forging a different input, combine into a valid transaction whose
      real fee neither panel showed (the 2020 segwit fee attack).
    */
    const vault = buildVault()
    const { psbtBase64, source } = vaultSpend(vault, 100_000_000)
    const lying = withInput(psbtBase64, 0, {
      nonWitnessUtxo: rawTx(fundAddress(source.getAddress(), 10_000)), // same script, other txid
      witnessUtxo: { script: source.getScriptPubKey(), value: 10_000n },
    })
    const result = decodePsbt(lying, TESTNET, vault.changeDescriptor)
    expect(result).toHaveProperty('reason')
    expect((result as DecodeError).reason).toMatch(/not the one it spends/i)
  })

  it('refuses a witnessUtxo whose SCRIPT disagrees with the proven output', () => {
    const vault = buildVault()
    const other = buildVault()
    const { psbtBase64 } = vaultSpend(vault)
    const foreignScript = new Output({ descriptor: other.descriptor, index: 0, network: net }).getScriptPubKey()
    const lying = withInput(psbtBase64, 0, { witnessUtxo: { script: foreignScript, value: 100_000n } })
    const result = decodePsbt(lying, TESTNET, vault.changeDescriptor)
    expect(result).toHaveProperty('reason')
    expect((result as DecodeError).reason).toMatch(/script/i)
  })

  it('REQUIRES the previous transaction on every input that names the signing key', () => {
    // A bare witnessUtxo is a claim the signing key would be committing to. Platform, Sparrow
    // and Electrum PSBTs all carry the previous transaction, so requiring it costs nothing.
    const vault = buildVault()
    const { psbtBase64, source } = vaultSpend(vault)
    const segwitOnly = withInput(psbtBase64, 0, {
      nonWitnessUtxo: undefined,
      witnessUtxo: { script: source.getScriptPubKey(), value: 100_000n },
    })
    const result = decodePsbt(segwitOnly, TESTNET, vault.changeDescriptor, fingerprintOf(vault.mnemonics[0]))
    expect(result).toHaveProperty('reason')
    expect((result as DecodeError).reason).toMatch(/previous transaction/i)
    expect(() => signPsbt(vault.mnemonics[0], TESTNET, segwitOnly)).toThrow(/previous transaction/i)
  })

  it('REFUSES an input that does NOT name the signing key with witnessUtxo alone', () => {
    // Was accepted ("someone else's money") until 2026-10-10: an unproven value on ANY input
    // sets the fee the panel shows, and that is the two-session fee attack.
    const vault = buildVault()
    const { psbtBase64, source } = vaultSpend(vault)
    const segwitOnly = withInput(psbtBase64, 0, {
      nonWitnessUtxo: undefined,
      witnessUtxo: { script: source.getScriptPubKey(), value: 100_000n },
    })
    const result = decodePsbt(segwitOnly, TESTNET, undefined, fingerprintOf(generateKey()))
    expect(result).toHaveProperty('reason')
    expect((result as DecodeError).reason).toMatch(/previous transaction/i)
  })
})

describe('🚨 vault matching uses the PROVEN input script, never witnessUtxo.script', () => {
  it("a witnessUtxo naming another saved vault cannot borrow that vault's change branch", () => {
    /*
      The signer hashes `nonWitnessUtxo`'s script; matching used to read `witnessUtxo.script`.
      Pointing the latter at a second saved vault the attacker controls made that vault's
      change address read as CHANGE, with no "several vaults" warning, on a valid signature.
    */
    const victim = buildVault()
    const attacker = buildVault()
    const { psbtBase64 } = vaultSpend(victim)
    const attackerScript = new Output({ descriptor: attacker.descriptor, index: 0, network: net }).getScriptPubKey()
    const lying = withInput(psbtBase64, 0, { witnessUtxo: { script: attackerScript, value: 100_000n } })
    const cache = [attacker, victim] // the attacker's vault listed first

    expect(findMatchingChangeDescriptor(lying, TESTNET, cache)).toBe(victim.changeDescriptor)
    expect(countMatchingVaults(lying, TESTNET, cache)).toBe(1)
    expect(decodePsbt(lying, TESTNET, victim.changeDescriptor)).toHaveProperty('reason')
  })
})

describe('🚨 matching and change follow the vault past its first 100 addresses', () => {
  /** A spend from `branch` index `at`, paying a stranger and (optionally) change at `changeAt`. */
  function spendFrom(vault: ReturnType<typeof buildVault>, branch: 'receive' | 'change', at: number, changeAt?: number) {
    const descriptor = branch === 'receive' ? vault.descriptor : vault.changeDescriptor
    const source = new Output({ descriptor, index: at, network: net })
    const psbt = new Psbt({ network: net as never })
    source.updatePsbtAsInput({ psbt, txHex: fundAddress(source.getAddress(), 100_000), vout: 0 } as never)
    psbt.addOutput({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: BigInt(60_000) } as never)
    let changeAddress: string | undefined
    if (changeAt !== undefined) {
      changeAddress = new Output({ descriptor: vault.changeDescriptor, index: changeAt, network: net }).getAddress()
      psbt.addOutput({ address: changeAddress, value: BigInt(39_000) } as never)
    }
    return { psbt, changeAddress }
  }

  /** The derivations Sparrow writes on a change output: every cosigner's key at that index. */
  function namedChange(vault: ReturnType<typeof buildVault>, index: number) {
    const keys = new Output({ descriptor: vault.changeDescriptor, index, network: net }).expand().expansionMap ?? {}
    return Object.values(keys).map((k) => ({
      masterFingerprint: k.masterFingerprint as Uint8Array,
      pubkey: k.pubkey as Uint8Array,
      path: k.path as string,
    }))
  }

  it('a spend funded from the CHANGE branch matches its vault and classifies its change', () => {
    // After a vault's first spend most coins sit on the change branch. Matching only receive
    // left every later spend in degraded mode, where an attacker output looks like any other.
    const vault = buildVault()
    const { psbt, changeAddress } = spendFrom(vault, 'change', 3, 4)
    const b64 = psbt.toBase64()
    const changeDescriptor = findMatchingChangeDescriptor(b64, TESTNET, [vault])
    expect(changeDescriptor).toBe(vault.changeDescriptor)
    const result = decodePsbt(b64, TESTNET, changeDescriptor) as DecodedPsbt
    expect(result.outputs.find((o) => o.address === changeAddress)?.change).toBe('change')
    expect(result.outputs.filter((o) => o.change === 'recipient')).toHaveLength(1)
  })

  it('an input past the scan window matches at the index its bip32Derivation names', () => {
    const vault = buildVault()
    const { psbt } = spendFrom(vault, 'receive', 250)
    expect(findMatchingChangeDescriptor(psbt.toBase64(), TESTNET, [vault])).toBe(vault.changeDescriptor)
  })

  it('change past the scan window is recognised at the index the OUTPUT names', () => {
    const vault = buildVault()
    const { psbt, changeAddress } = spendFrom(vault, 'receive', 0, 150)
    psbt.updateOutput(1, { bip32Derivation: namedChange(vault, 150) } as never)
    const result = decodePsbt(psbt.toBase64(), TESTNET, vault.changeDescriptor) as DecodedPsbt
    expect(result.outputs.find((o) => o.address === changeAddress)?.change).toBe('change')
  })

  it('change past the window with NO named index is found beside the deepest change input', () => {
    // The platform names no index on its change output. Its next change sits just past the
    // change this spend consumes, so the fallback scan follows the vault instead of index 0.
    const vault = buildVault()
    const { psbt, changeAddress } = spendFrom(vault, 'change', 140, 141)
    const b64 = psbt.toBase64()
    const changeDescriptor = findMatchingChangeDescriptor(b64, TESTNET, [vault])
    expect(changeDescriptor).toBe(vault.changeDescriptor)
    const result = decodePsbt(b64, TESTNET, changeDescriptor) as DecodedPsbt
    expect(result.outputs.find((o) => o.address === changeAddress)?.change).toBe('change')
  })

  it('a named index never decides: a foreign output that NAMES a change index is a recipient', () => {
    const vault = buildVault()
    const attacker = buildVault()
    const { psbt } = spendFrom(vault, 'receive', 0)
    const stolen = new Output({ descriptor: attacker.changeDescriptor, index: 0, network: net }).getAddress()
    psbt.addOutput({ address: stolen, value: BigInt(39_000) } as never)
    psbt.updateOutput(1, { bip32Derivation: namedChange(vault, 0) } as never) // the vault's own keys, index 0
    const result = decodePsbt(psbt.toBase64(), TESTNET, vault.changeDescriptor) as DecodedPsbt
    expect(result.outputs.find((o) => o.address === stolen)?.change).toBe('recipient')
  })

  it('a saved vault WITHOUT a change descriptor still counts as matched', () => {
    // What lets the panel say "this vault has no change descriptor" instead of the false
    // "this vault is not saved on this device".
    const vault = buildVault()
    const { psbt } = spendFrom(vault, 'receive', 0)
    expect(matchVaults(psbt.toBase64(), TESTNET, [{ descriptor: vault.descriptor }])).toEqual({ vaults: 1 })
  })

  it('the same vault saved twice is ONE vault, so the several-vaults warning stays quiet', () => {
    // Saving twice is allowed by design (vaults.ts addVaultBackup).
    const vault = buildVault()
    const { psbt } = spendFrom(vault, 'receive', 0)
    expect(countMatchingVaults(psbt.toBase64(), TESTNET, [vault, { ...vault }])).toBe(1)
  })
})
