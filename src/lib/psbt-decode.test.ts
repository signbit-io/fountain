import { describe, it, expect } from 'vitest'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as descriptors from '@bitcoinerlab/descriptors'
import { generateKey, accountKey } from './key.js'
import { decodePsbt, findMatchingChangeDescriptor, type DecodedPsbt } from './psbt-decode.js'
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
