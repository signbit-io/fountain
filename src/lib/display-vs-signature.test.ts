import { describe, it, expect } from 'vitest'
import * as ecc from '@bitcoinerlab/secp256k1'
import * as descriptors from '@bitcoinerlab/descriptors'
import { generateKey, accountKey, signPsbt } from './key.js'
import { decodePsbt, findMatchingChangeDescriptor, type DecodedPsbt } from './psbt-decode.js'
import type { NetworkName } from './bitcoin-network.js'

/*
  DISPLAY-VS-SIGNATURE DIVERGENCE — the crown jewel of an air-gapped signer.

  🚨 THE ONLY QUESTION THIS DEVICE EXISTS TO ANSWER IS "DID IT SIGN EXACTLY WHAT IT SHOWED?"
  Fountain is offline, so there is no request to forge and no session to steal. Every other
  guarantee it makes is downstream of this one: a user reads the outputs on screen, decides
  the spend is what they agreed to, and presses Sign. If the bytes that get signed are not the
  bytes that were decoded, the review step is theatre and every other test in this repo is
  guarding a door that is already open.

  ⚠️ `decodePsbt` and `signPsbt` PARSE THE BASE64 INDEPENDENTLY — there is no shared PSBT
  object between them, by design (decode is display-only and must never be able to mutate what
  gets signed). The cost of that design is that "they agree" is an INVARIANT NOBODY ENFORCED:
  both were thoroughly tested in isolation, and nothing tied one to the other.

  These tests close that. The technique throughout is to sign, then decode THE SIGNED OUTPUT
  and compare it against the decode of the input — signing must be a pure addition of
  signatures, changing no output, no amount, and no fee.
*/

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

function fundAddress(address: string, valueSats: number) {
  const prev = new bjs.Transaction()
  prev.version = 2
  prev.addInput(Buffer.alloc(32, 1), 0)
  prev.addOutput(bjs.address.toOutputScript(address, net), BigInt(valueSats))
  return prev.toHex()
}

const RECIPIENT = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

/**
 * A realistic spend from the vault: one input, one external recipient, one change output
 * back to the vault's own change branch.
 */
function buildSpend(vault: ReturnType<typeof buildVault>, opts: { value?: number; amount?: number; fee?: number } = {}) {
  const value = opts.value ?? 200_000
  const amount = opts.amount ?? 120_000
  const fee = opts.fee ?? 500
  const receiveOut = new Output({ descriptor: vault.descriptor, index: 0, network: net as never })
  const changeOut = new Output({ descriptor: vault.changeDescriptor, index: 0, network: net as never })
  const psbt = new Psbt({ network: net as never })
  receiveOut.updatePsbtAsInput({ psbt, txHex: fundAddress(receiveOut.getAddress(), value), vout: 0 })
  psbt.addOutput({ address: RECIPIENT, value: BigInt(amount) })
  psbt.addOutput({ address: changeOut.getAddress(), value: BigInt(value - amount - fee) })
  return psbt.toBase64()
}

/** Decode helper mirroring SignScreen: find the change descriptor from the cache, then decode. */
function decodeAsScreenWould(psbtBase64: string, vault: ReturnType<typeof buildVault>): DecodedPsbt {
  const changeDescriptor = findMatchingChangeDescriptor(psbtBase64, TESTNET, [vault])
  const result = decodePsbt(psbtBase64, TESTNET, changeDescriptor)
  if ('reason' in result) throw new Error(`decode failed: ${result.reason}`)
  return result
}

describe('🚨 what was SHOWN is what gets SIGNED', () => {
  it('signing changes NO output, NO amount and NO fee', () => {
    /*
      🚨 The core invariant. Signing must be a pure ADDITION of signature data — the user
      reviewed the outputs before pressing Sign, and any change to them afterwards makes that
      review meaningless. Compared through the DECODER rather than by string equality, because
      the base64 legitimately differs (it now carries a partial signature); what must not
      differ is the transaction's effect.
    */
    const vault = buildVault()
    const unsigned = buildSpend(vault)

    const shown = decodeAsScreenWould(unsigned, vault)
    const signed = signPsbt(vault.mnemonics[0], TESTNET, unsigned)
    const after = decodeAsScreenWould(signed, vault)

    expect(after.outputs).toEqual(shown.outputs)
    expect(after.feeSats).toBe(shown.feeSats)
    // And the signature really was added — otherwise this passes trivially.
    expect(signed).not.toBe(unsigned)
  })

  it('holds across EVERY key in a 3-of-5, and after the quorum is reached', () => {
    /*
      ⚠️ The multi-keyholder case is the one this app exists for, and it is where a
      display/signature divergence would be hardest to spot: each signer sees the panel
      independently, so a drift introduced by the SECOND signature is invisible to the first.
      Every keyholder must see the same outputs, and the fully-signed PSBT must still decode
      to what the first one approved.
    */
    const vault = buildVault(3)
    const unsigned = buildSpend(vault)
    const shown = decodeAsScreenWould(unsigned, vault)

    let psbt = unsigned
    for (let i = 0; i < 3; i++) {
      const before = decodeAsScreenWould(psbt, vault)
      // 🚨 Each keyholder sees exactly what the first one did.
      expect(before.outputs).toEqual(shown.outputs)
      expect(before.feeSats).toBe(shown.feeSats)
      psbt = signPsbt(vault.mnemonics[i], TESTNET, psbt)
    }

    const final = decodeAsScreenWould(psbt, vault)
    expect(final.outputs).toEqual(shown.outputs)
    expect(final.feeSats).toBe(shown.feeSats)
  })

  it('🚨 the decoded RECIPIENT is the address the signed tx actually pays', () => {
    /*
      🚨 The substitution attack in its purest form: a PSBT that DISPLAYS one recipient and
      PAYS another. Rather than trust the decoder's own output twice, this reaches into the
      signed PSBT's raw output scripts and asserts the recipient the panel named is genuinely
      among them, at the amount it named.
    */
    const vault = buildVault()
    const unsigned = buildSpend(vault, { amount: 77_777 })
    const shown = decodeAsScreenWould(unsigned, vault)

    const signed = signPsbt(vault.mnemonics[0], TESTNET, unsigned)
    const parsed = Psbt.fromBase64(signed, { network: net as never })

    const recipient = shown.outputs.find((o) => o.change === 'recipient')!
    expect(recipient.address).toBe(RECIPIENT)
    expect(recipient.amountSats).toBe(77_777)

    // The signed transaction's own bytes must contain that exact script and value.
    const wanted = Buffer.from(bjs.address.toOutputScript(RECIPIENT, net)).toString('hex')
    const match = parsed.txOutputs.find(
      (o) => Buffer.from(o.script as Uint8Array).toString('hex') === wanted,
    )
    expect(match).toBeDefined()
    expect(Number(match!.value)).toBe(77_777)
  })

  it('🚨 a PSBT altered AFTER the decode does not keep the old signature', () => {
    /*
      🚨 The time-of-check/time-of-use question. Suppose the reviewed PSBT is swapped for a
      different one between the panel rendering and the Sign press. The defence is not that
      Fountain detects the swap — it signs what it is handed — but that a SIGHASH commits to
      the outputs, so a signature made over the original does not survive onto the altered
      transaction. This pins that property, which is what makes the review meaningful at all.
    */
    const vault = buildVault()
    const original = buildSpend(vault, { amount: 120_000 })
    const tampered = buildSpend(vault, { amount: 190_000 }) // same input, different payout

    const signedOriginal = signPsbt(vault.mnemonics[0], TESTNET, original)
    const sigOriginal = Psbt.fromBase64(signedOriginal, { network: net as never })
      .data.inputs[0]!.partialSig![0]!.signature

    const signedTampered = signPsbt(vault.mnemonics[0], TESTNET, tampered)
    const sigTampered = Psbt.fromBase64(signedTampered, { network: net as never })
      .data.inputs[0]!.partialSig![0]!.signature

    // Different outputs → different sighash → a genuinely different signature.
    expect(Buffer.from(sigOriginal).toString('hex')).not.toBe(Buffer.from(sigTampered).toString('hex'))
  })

  it('🚨 CHANGE is classified from the descriptor, so a fake "change" output is a RECIPIENT', () => {
    /*
      🚨 The attack that makes a spend look smaller than it is. An attacker-supplied PSBT sends
      money to an address they control and hopes it is presented as change — money "returning
      to you" reads as harmless, so a 190k theft displays as a 10k spend.

      The defence is that classification is script MEMBERSHIP of the vault's own change branch,
      never a label or a heuristic. Here the second output goes to a DIFFERENT vault's change
      address: structurally identical, and it must still read as a recipient.
    */
    const vault = buildVault()
    const attacker = buildVault()
    const receiveOut = new Output({ descriptor: vault.descriptor, index: 0, network: net as never })
    const attackerChange = new Output({ descriptor: attacker.changeDescriptor, index: 0, network: net as never })

    const psbt = new Psbt({ network: net as never })
    receiveOut.updatePsbtAsInput({ psbt, txHex: fundAddress(receiveOut.getAddress(), 200_000), vout: 0 })
    psbt.addOutput({ address: RECIPIENT, value: BigInt(10_000) })
    psbt.addOutput({ address: attackerChange.getAddress(), value: BigInt(189_500) })

    const shown = decodeAsScreenWould(psbt.toBase64(), vault)

    // 🚨 NOTHING is change here — the vault gets nothing back.
    expect(shown.outputs.every((o) => o.change === 'recipient')).toBe(true)
    expect(shown.changeClassified).toBe(true)
    // The user is shown the full 199,500 leaving, not a 10,000 spend.
    const leaving = shown.outputs.filter((o) => o.change === 'recipient').reduce((s, o) => s + o.amountSats, 0)
    expect(leaving).toBe(199_500)
  })

  it('🚨 with SEVERAL vaults cached, change is classified against the RIGHT one', () => {
    /*
      🚨 A keyholder in several vaults has several cached descriptors, and classifying against
      the wrong one is silent: the change branch of vault B does not contain vault A's change
      address, so A's genuine change would display as a RECIPIENT — the user sees their own
      money leaving and cannot tell it is coming back.

      ⚠️ The reverse error is the dangerous one and is covered above (a foreign address must
      never read as change). This is the direction that erodes TRUST rather than funds: a panel
      that cries theft on an ordinary spend gets ignored, and then it is ignored when it matters.
    */
    const vaultA = buildVault()
    const vaultB = buildVault()
    const spend = buildSpend(vaultA)

    // Cache order deliberately puts the WRONG vault first.
    const changeDescriptor = findMatchingChangeDescriptor(spend, TESTNET, [vaultB, vaultA])
    expect(changeDescriptor).toBe(vaultA.changeDescriptor)

    const result = decodePsbt(spend, TESTNET, changeDescriptor)
    if ('reason' in result) throw new Error(result.reason)

    expect(result.outputs.filter((o) => o.change === 'change')).toHaveLength(1)
    expect(result.outputs.filter((o) => o.change === 'recipient')).toHaveLength(1)
  })

  it('🚨 DEGRADED MODE never GUESSES — an unknown vault marks every output unknown', () => {
    /*
      🚨 With no cached descriptor, the honest answer is "I cannot tell which of these is
      change", and the app must say so rather than assume the last output is change (the
      heuristic every naive decoder reaches for). Guessing here would let an attacker place a
      hostile output last and have it labelled change — the previous test's attack, but
      succeeding.
    */
    const vault = buildVault()
    const unsigned = buildSpend(vault)

    // No candidates at all — the vault was never saved on this device.
    const changeDescriptor = findMatchingChangeDescriptor(unsigned, TESTNET, [])
    expect(changeDescriptor).toBeUndefined()

    const result = decodePsbt(unsigned, TESTNET, changeDescriptor)
    if ('reason' in result) throw new Error(result.reason)

    expect(result.changeClassified).toBe(false)
    expect(result.outputs.every((o) => o.change === 'unknown')).toBe(true)
    // ⚠️ Amounts and fee are still exact — they come from the PSBT's own bytes, and
    // withholding them would push the user to sign with LESS information, not more.
    expect(result.feeSats).toBe(500)
    expect(result.outputs.map((o) => o.amountSats)).toEqual([120_000, 79_500])
  })

  it('🚨 the FEE the panel shows is the fee the signed transaction actually pays', () => {
    /*
      🚨 The fee is the one number a user cannot derive by eye — it is inputs minus outputs,
      and neither total is on screen. An inflated fee is a real theft vector (miner-extractable,
      and it looks like an ordinary spend), so the displayed figure must come from the same
      bytes that get signed.
    */
    const vault = buildVault()
    const unsigned = buildSpend(vault, { value: 500_000, amount: 300_000, fee: 12_345 })

    const shown = decodeAsScreenWould(unsigned, vault)
    expect(shown.feeSats).toBe(12_345)

    const signed = signPsbt(vault.mnemonics[0], TESTNET, unsigned)
    const parsed = Psbt.fromBase64(signed, { network: net as never })
    const outTotal = parsed.txOutputs.reduce((s, o) => s + Number(o.value), 0)
    const inTotal = Number(parsed.data.inputs[0]!.witnessUtxo!.value)

    expect(inTotal - outTotal).toBe(shown.feeSats)
  })

  it('🚨 refuses to sign what it could not decode — no silent signing of an opaque PSBT', () => {
    /*
      🚨 The failure mode that would quietly undo this whole file: a PSBT the panel cannot
      decode (so the user is shown NOTHING) still being signable. Then the review step is not
      merely wrong, it is absent, and the user signs a blank. Both must reject the same input.
    */
    for (const bad of ['not a psbt at all', '', 'cHNidP8=']) {
      const decoded = decodePsbt(bad, TESTNET)
      expect('reason' in decoded, `${JSON.stringify(bad)} must not decode`).toBe(true)
      expect(() => signPsbt(generateKey(), TESTNET, bad), `${JSON.stringify(bad)} must not sign`).toThrow()
    }
  })
})

/*
  🚨 THE LIBRARY REFUSES WHAT THE REVIEW REFUSES (2026-10-04 mainnet sweep).

  The test above fed `signPsbt` three strings no parser accepts, and so passed while every
  WELL-FORMED PSBT the panel refused was still signable: the screen dropped the refusal
  (`return null`), the panel simply vanished, and the Sign button stayed live. One edited field
  (a witnessUtxo value beside a truthful previous transaction, or a foreign input with no value
  at all) was enough to make a user sign a transaction they were never shown.
*/
describe('🚨 signPsbt refuses every PSBT the review refuses', () => {
  /** Raw access to the fields these tests corrupt. */
  type Inputs = { data: { inputs: { witnessUtxo?: { script: Uint8Array; value: bigint }; sighashType?: number }[] } }

  it('a witnessUtxo value that disagrees with the previous transaction', () => {
    const vault = buildVault()
    const receiveOut = new Output({ descriptor: vault.descriptor, index: 0, network: net as never })
    const psbt = new Psbt({ network: net as never })
    receiveOut.updatePsbtAsInput({ psbt, txHex: fundAddress(receiveOut.getAddress(), 100_000_000), vout: 0 })
    psbt.addOutput({ address: RECIPIENT, value: BigInt(99_990_000) })
    const raw = (psbt as unknown as Inputs).data.inputs[0]!
    raw.witnessUtxo = { script: raw.witnessUtxo!.script, value: 5n }
    const lying = psbt.toBase64()

    expect(decodePsbt(lying, TESTNET), 'the review refuses it').toHaveProperty('reason')
    expect(() => signPsbt(vault.mnemonics[0], TESTNET, lying), 'so the signer must too').toThrow(/two different values/i)
  })

  it('a foreign input that carries no value at all', () => {
    const vault = buildVault()
    const receiveOut = new Output({ descriptor: vault.descriptor, index: 0, network: net as never })
    const psbt = new Psbt({ network: net as never })
    receiveOut.updatePsbtAsInput({ psbt, txHex: fundAddress(receiveOut.getAddress(), 100_000_000), vout: 0 })
    psbt.addInput({ hash: Buffer.alloc(32, 0xaa), index: 0 })
    psbt.addOutput({ address: RECIPIENT, value: BigInt(99_990_000) })
    const opaque = psbt.toBase64()

    expect(decodePsbt(opaque, TESTNET)).toHaveProperty('reason')
    expect(() => signPsbt(vault.mnemonics[0], TESTNET, opaque)).toThrow(/no recoverable value/i)
  })

  it('never reports "signed" when an input that names this key went unsigned', () => {
    /*
      signBIP32 signs what it can and silently skips the rest, throwing only when NOTHING was
      signed. Here input 1 asks for SIGHASH_NONE, which the signer refuses, so the user used to
      be told "Signed" over a PSBT their key had only half signed.
    */
    const vault = buildVault()
    const psbt = new Psbt({ network: net as never })
    for (const index of [0, 1]) {
      const out = new Output({ descriptor: vault.descriptor, index, network: net as never })
      out.updatePsbtAsInput({ psbt, txHex: fundAddress(out.getAddress(), 100_000), vout: 0 })
    }
    psbt.addOutput({ address: RECIPIENT, value: BigInt(190_000) })
    ;(psbt as unknown as Inputs).data.inputs[1]!.sighashType = 0x02

    expect(() => signPsbt(vault.mnemonics[0], TESTNET, psbt.toBase64())).toThrow(/input 1/i)
  })

  it('two sessions that each forge ONE previous transaction cannot both be signed', () => {
    /*
      The 2020 segwit fee attack, in the shape the platform's own PSBTs have (a previous
      transaction on every input). Each session forges a different input's previous tx at
      10,000 sats; each panel showed a 10,000-sat fee; the signer skipped the forged input and
      signed the honest one; together the two signatures finalized a transaction paying
      100,000,000 sats to miners. Both sessions are now refused before anything is signed.
    */
    const vault = buildVault()
    const outs = [0, 1].map((index) => new Output({ descriptor: vault.descriptor, index, network: net as never }))
    const realHex = outs.map((o) => fundAddress(o.getAddress(), 100_000_000))
    const fakeHex = outs.map((o) => fundAddress(o.getAddress(), 10_000))
    const bjsTx = descriptors.createBitcoinjsLib(ecc) as unknown as {
      Transaction: { fromHex: (h: string) => { getHash: () => Uint8Array; toBuffer: () => Uint8Array } }
    }

    const session = (forge: 0 | 1) => {
      const honest = new Psbt({ network: net as never })
      outs.forEach((o, i) => o.updatePsbtAsInput({ psbt: honest, txHex: realHex[i]!, vout: 0 }))
      const forged = new Psbt({ network: net as never })
      honest.txInputs.forEach((txIn, i) => {
        const d = honest.data.inputs[i]!
        forged.addInput({
          hash: txIn.hash,
          index: txIn.index,
          sequence: txIn.sequence,
          witnessScript: d.witnessScript,
          bip32Derivation: d.bip32Derivation,
          nonWitnessUtxo: i === forge ? bjsTx.Transaction.fromHex(fakeHex[i]!).toBuffer() : d.nonWitnessUtxo,
          witnessUtxo: { script: d.witnessUtxo!.script, value: i === forge ? 10_000n : d.witnessUtxo!.value },
        } as never)
      })
      forged.addOutput({ address: RECIPIENT, value: BigInt(10_000_000) })
      forged.addOutput({ address: new Output({ descriptor: vault.changeDescriptor, index: 0, network: net as never }).getAddress(), value: BigInt(90_000_000) })
      return forged.toBase64()
    }

    for (const forge of [0, 1] as const) {
      const b64 = session(forge)
      expect(decodePsbt(b64, TESTNET), `session ${forge + 1}: the review`).toHaveProperty('reason')
      expect(() => signPsbt(vault.mnemonics[0], TESTNET, b64), `session ${forge + 1}: the signer`).toThrow(/not the one it spends/i)
    }
  })

  it('two sessions that each STRIP one input to a bare witnessUtxo cannot both be signed', () => {
    /*
      The same attack with no forgery at all (external review, 2026-10-10): drop one input's
      derivation and previous transaction so it reads as someone else's, and claim it holds
      10,000 sats. Each panel showed a 30,000-sat fee, no alarm, one vault; the key signed the
      intact input; the two sessions' signatures finalized paying ~1 BTC to miners.
    */
    const vault = buildVault()
    const outs = [0, 1].map((index) => new Output({ descriptor: vault.descriptor, index, network: net as never }))
    const realHex = outs.map((o) => fundAddress(o.getAddress(), 100_000_000))

    const session = (strip: 0 | 1) => {
      const honest = new Psbt({ network: net as never })
      outs.forEach((o, i) => o.updatePsbtAsInput({ psbt: honest, txHex: realHex[i]!, vout: 0 }))
      const lying = new Psbt({ network: net as never })
      honest.txInputs.forEach((txIn, i) => {
        const d = honest.data.inputs[i]!
        lying.addInput(
          (i === strip
            ? { hash: txIn.hash, index: txIn.index, sequence: txIn.sequence, witnessUtxo: { script: d.witnessUtxo!.script, value: 10_000n } }
            : { hash: txIn.hash, index: txIn.index, sequence: txIn.sequence, witnessScript: d.witnessScript, bip32Derivation: d.bip32Derivation, nonWitnessUtxo: d.nonWitnessUtxo, witnessUtxo: d.witnessUtxo }) as never,
        )
      })
      lying.addOutput({ address: RECIPIENT, value: BigInt(10_000_000) })
      lying.addOutput({ address: new Output({ descriptor: vault.changeDescriptor, index: 0, network: net as never }).getAddress(), value: BigInt(89_980_000) })
      return lying.toBase64()
    }

    for (const strip of [0, 1] as const) {
      const b64 = session(strip)
      expect(decodePsbt(b64, TESTNET), `session ${strip + 1}: the review`).toHaveProperty('reason')
      expect(() => signPsbt(vault.mnemonics[0], TESTNET, b64), `session ${strip + 1}: the signer`).toThrow(/previous transaction/i)
    }
  })
})
